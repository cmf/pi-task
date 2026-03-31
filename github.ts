export type GitHubIssueState = "OPEN" | "CLOSED";

export type GitHubClientConfig = {
    owner: string;
    repo: string;
    token?: string;
    endpoint?: string;
    userAgent?: string;
};

export type GitHubIssueSummary = {
    id: string;
    number: number;
    title: string;
    body: string;
    state: GitHubIssueState;
    createdAt: string;
    closedAt: string | null;
    parent: {id: string; number: number; title: string} | null;
    labels: string[];
};

export type GitHubIssueComment = {
    id: string;
    body: string;
    createdAt: string;
    authorLogin: string | null;
};

export type GitHubIssueDetail = GitHubIssueSummary & {
    comments: GitHubIssueComment[];
};

type GraphQLResponse<T> = {
    data?: T;
    errors?: Array<{
        message: string;
        path?: Array<string | number>;
        extensions?: Record<string, unknown>;
    }>;
};

type PageInfo = {
    hasNextPage: boolean;
    endCursor: string | null;
};

type RawIssueNode = {
    id: string;
    number: number;
    title: string;
    body?: string | null;
    state: GitHubIssueState;
    createdAt: string;
    closedAt?: string | null;
    parent?: {
        id: string;
        number: number;
        title: string;
    } | null;
    labels?: {
        nodes?: Array<{name?: string | null} | null> | null;
    } | null;
};

type ListIssuesResponse = {
    repository: {
        issues: {
            nodes?: Array<RawIssueNode | null> | null;
            pageInfo: PageInfo;
        };
    } | null;
};

type ListSubIssuesResponse = {
    node: {
        subIssues: {
            nodes?: Array<RawIssueNode | null> | null;
            pageInfo: PageInfo;
        };
    } | null;
};

type SearchIssuesResponse = {
    search: {
        nodes?: Array<RawIssueNode | null> | null;
        pageInfo: PageInfo;
    };
};

export class GitHubGraphQLError extends Error {
    readonly status: number;
    readonly errors: Array<{
        message: string;
        path?: Array<string | number>;
        extensions?: Record<string, unknown>;
    }>;

    constructor(
        status: number,
        errors: Array<{
            message: string;
            path?: Array<string | number>;
            extensions?: Record<string, unknown>;
        }>
    ) {
        super(
            errors.map((error) => error.message).join("; ") || `GitHub GraphQL request failed with status ${status}`
        );
        this.name = "GitHubGraphQLError";
        this.status = status;
        this.errors = errors;
    }
}

export class GitHubSubIssueLinkError extends Error {
    readonly parentIssueId: string;
    readonly createdIssue: GitHubIssueSummary;
    readonly causeError: unknown;

    constructor(params: {
        parentIssueId: string;
        createdIssue: GitHubIssueSummary;
        causeError: unknown;
    }) {
        const causeMessage = params.causeError instanceof Error
            ? params.causeError.message
            : String(params.causeError);

        super(
            `Created issue #${params.createdIssue.number} (${params.createdIssue.id}) but failed to link it as a sub-issue of parent ${params.parentIssueId}: ${causeMessage}`
        );

        this.name = "GitHubSubIssueLinkError";
        this.parentIssueId = params.parentIssueId;
        this.createdIssue = params.createdIssue;
        this.causeError = params.causeError;
    }
}

const DEFAULT_ENDPOINT = "https://api.github.com/graphql";
const DEFAULT_USER_AGENT = "pi-task-extension-github";
const DEFAULT_PAGE_SIZE = 100;
const repositoryIdCache = new Map<string, string>();

function getToken(config: GitHubClientConfig): string {
    const token = (config.token ?? process.env.GITHUB_TOKEN ?? "").trim();
    if (!token) {
        throw new Error("Missing GitHub token. Set config.token or GITHUB_TOKEN.");
    }
    return token;
}

function cacheKey(config: GitHubClientConfig): string {
    return `${config.endpoint ?? DEFAULT_ENDPOINT}::${config.owner}/${config.repo}`;
}

function mapIssueNode(node: RawIssueNode): GitHubIssueSummary {
    const labels = (node.labels?.nodes ?? [])
        .map((item) => item?.name?.trim() ?? "")
        .filter((name) => Boolean(name));

    return {
        id: node.id,
        number: node.number,
        title: node.title,
        body: node.body ?? "",
        state: node.state,
        createdAt: node.createdAt,
        closedAt: node.closedAt ?? null,
        parent: node.parent
            ? {
                id: node.parent.id,
                number: node.parent.number,
                title: node.parent.title,
            }
            : null,
        labels,
    };
}

async function graphql<T>(
    config: GitHubClientConfig,
    query: string,
    variables?: Record<string, unknown>
): Promise<T> {
    const token = getToken(config);
    const response = await fetch(config.endpoint ?? DEFAULT_ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": config.userAgent ?? DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({query, variables}),
    });

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (!response.ok || (payload.errors && payload.errors.length > 0) || !payload.data) {
        throw new GitHubGraphQLError(response.status, payload.errors ?? [{message: "Unknown GraphQL error"}]);
    }

    return payload.data;
}

export async function getRepositoryId(config: GitHubClientConfig): Promise<string> {
    const key = cacheKey(config);
    const cached = repositoryIdCache.get(key);
    if (cached) {
        return cached;
    }

    const data = await graphql<{
        repository: {id: string} | null;
    }>(
        config,
        `query RepoId($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                id
            }
        }`,
        {owner: config.owner, repo: config.repo}
    );

    const id = data.repository?.id?.trim() ?? "";
    if (!id) {
        throw new Error(`Repository not found: ${config.owner}/${config.repo}`);
    }

    repositoryIdCache.set(key, id);
    return id;
}

export async function getIssueByNumber(
    config: GitHubClientConfig,
    issueNumber: number,
    options?: {commentsFirst?: number}
): Promise<GitHubIssueDetail | null> {
    const commentsFirst = Math.max(0, Math.min(options?.commentsFirst ?? 50, 100));

    const data = await graphql<{
        repository: {
            issue: (RawIssueNode & {
                comments?: {
                    nodes?: Array<{
                        id: string;
                        body?: string | null;
                        createdAt: string;
                        author?: {login?: string | null} | null;
                    } | null> | null;
                } | null;
            }) | null;
        } | null;
    }>(
        config,
        `query IssueByNumber($owner: String!, $repo: String!, $number: Int!, $commentsFirst: Int!) {
            repository(owner: $owner, name: $repo) {
                issue(number: $number) {
                    id
                    number
                    title
                    body
                    state
                    createdAt
                    closedAt
                    parent {
                        id
                        number
                        title
                    }
                    labels(first: 50) {
                        nodes {
                            name
                        }
                    }
                    comments(first: $commentsFirst) {
                        nodes {
                            id
                            body
                            createdAt
                            author {
                                login
                            }
                        }
                    }
                }
            }
        }`,
        {
            owner: config.owner,
            repo: config.repo,
            number: issueNumber,
            commentsFirst,
        }
    );

    const issueNode = data.repository?.issue ?? null;
    if (!issueNode) {
        return null;
    }

    const summary = mapIssueNode(issueNode);
    const comments = (issueNode.comments?.nodes ?? [])
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
        .map((node) => ({
            id: node.id,
            body: node.body ?? "",
            createdAt: node.createdAt,
            authorLogin: node.author?.login ?? null,
        }));

    return {
        ...summary,
        comments,
    };
}

export async function createIssue(
    config: GitHubClientConfig,
    params: {
        title: string;
        body?: string;
        labelIds?: string[];
    }
): Promise<GitHubIssueSummary> {
    const repositoryId = await getRepositoryId(config);

    const data = await graphql<{
        createIssue: {
            issue: RawIssueNode;
        };
    }>(
        config,
        `mutation CreateIssue(
            $repositoryId: ID!,
            $title: String!,
            $body: String,
            $labelIds: [ID!]
        ) {
            createIssue(input: {
                repositoryId: $repositoryId,
                title: $title,
                body: $body,
                labelIds: $labelIds
            }) {
                issue {
                    id
                    number
                    title
                    body
                    state
                    createdAt
                    closedAt
                    parent {
                        id
                        number
                        title
                    }
                    labels(first: 50) {
                        nodes {
                            name
                        }
                    }
                }
            }
        }`,
        {
            repositoryId,
            title: params.title,
            body: params.body ?? "",
            labelIds: params.labelIds && params.labelIds.length > 0 ? params.labelIds : undefined,
        }
    );

    return mapIssueNode(data.createIssue.issue);
}

export async function addSubIssue(
    config: GitHubClientConfig,
    parentIssueId: string,
    childIssueId: string
): Promise<void> {
    await graphql<{
        addSubIssue: {
            issue: {id: string};
            subIssue: {id: string};
        };
    }>(
        config,
        `mutation AddSubIssue($parentIssueId: ID!, $childIssueId: ID!) {
            addSubIssue(input: {
                issueId: $parentIssueId,
                subIssueId: $childIssueId
            }) {
                issue {
                    id
                }
                subIssue {
                    id
                }
            }
        }`,
        {
            parentIssueId,
            childIssueId,
        }
    );
}

export async function createIssueWithParent(
    config: GitHubClientConfig,
    params: {
        parentIssueId: string;
        title: string;
        body?: string;
        labelIds?: string[];
    }
): Promise<GitHubIssueSummary> {
    const issue = await createIssue(config, {
        title: params.title,
        body: params.body,
        labelIds: params.labelIds,
    });

    try {
        await addSubIssue(config, params.parentIssueId, issue.id);
        return issue;
    } catch (error) {
        throw new GitHubSubIssueLinkError({
            parentIssueId: params.parentIssueId,
            createdIssue: issue,
            causeError: error,
        });
    }
}

export async function closeIssue(config: GitHubClientConfig, issueId: string): Promise<GitHubIssueSummary> {
    const data = await graphql<{
        closeIssue: {
            issue: RawIssueNode;
        };
    }>(
        config,
        `mutation CloseIssue($issueId: ID!) {
            closeIssue(input: {issueId: $issueId}) {
                issue {
                    id
                    number
                    title
                    body
                    state
                    createdAt
                    closedAt
                    parent {
                        id
                        number
                        title
                    }
                    labels(first: 50) {
                        nodes {
                            name
                        }
                    }
                }
            }
        }`,
        {issueId}
    );

    return mapIssueNode(data.closeIssue.issue);
}

export async function updateIssueBody(
    config: GitHubClientConfig,
    issueId: string,
    body: string
): Promise<GitHubIssueSummary> {
    const data = await graphql<{
        updateIssue: {
            issue: RawIssueNode;
        };
    }>(
        config,
        `mutation UpdateIssueBody($issueId: ID!, $body: String!) {
            updateIssue(input: {
                id: $issueId,
                body: $body
            }) {
                issue {
                    id
                    number
                    title
                    body
                    state
                    createdAt
                    closedAt
                    parent {
                        id
                        number
                        title
                    }
                    labels(first: 50) {
                        nodes {
                            name
                        }
                    }
                }
            }
        }`,
        {issueId, body}
    );

    return mapIssueNode(data.updateIssue.issue);
}

export async function addIssueComment(
    config: GitHubClientConfig,
    issueId: string,
    body: string
): Promise<GitHubIssueComment> {
    const data = await graphql<{
        addComment: {
            commentEdge: {
                node: {
                    id: string;
                    body?: string | null;
                    createdAt: string;
                    author?: {login?: string | null} | null;
                };
            };
        };
    }>(
        config,
        `mutation AddComment($issueId: ID!, $body: String!) {
            addComment(input: {
                subjectId: $issueId,
                body: $body
            }) {
                commentEdge {
                    node {
                        id
                        body
                        createdAt
                        author {
                            login
                        }
                    }
                }
            }
        }`,
        {issueId, body}
    );

    const node = data.addComment.commentEdge.node;
    return {
        id: node.id,
        body: node.body ?? "",
        createdAt: node.createdAt,
        authorLogin: node.author?.login ?? null,
    };
}

export async function listIssues(
    config: GitHubClientConfig,
    options?: {
        states?: GitHubIssueState[];
        pageSize?: number;
        orderDirection?: "ASC" | "DESC";
    }
): Promise<GitHubIssueSummary[]> {
    const pageSize = Math.max(1, Math.min(options?.pageSize ?? DEFAULT_PAGE_SIZE, 100));
    const states = options?.states ?? ["OPEN", "CLOSED"];
    const direction = options?.orderDirection ?? "ASC";

    const items: GitHubIssueSummary[] = [];
    let after: string | null = null;

    while (true) {
        const data: ListIssuesResponse = await graphql<ListIssuesResponse>(
            config,
            `query ListIssues(
                $owner: String!,
                $repo: String!,
                $states: [IssueState!],
                $first: Int!,
                $after: String,
                $direction: OrderDirection!
            ) {
                repository(owner: $owner, name: $repo) {
                    issues(
                        states: $states,
                        first: $first,
                        after: $after,
                        orderBy: {field: CREATED_AT, direction: $direction}
                    ) {
                        nodes {
                            id
                            number
                            title
                            body
                            state
                            createdAt
                            closedAt
                            parent {
                                id
                                number
                                title
                            }
                            labels(first: 50) {
                                nodes {
                                    name
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            }`,
            {
                owner: config.owner,
                repo: config.repo,
                states,
                first: pageSize,
                after,
                direction,
            }
        );

        const repository = data.repository;
        if (!repository) {
            break;
        }

        const issues = repository.issues;
        const mapped = (issues.nodes ?? [])
            .filter((node: RawIssueNode | null): node is RawIssueNode => Boolean(node))
            .map((node: RawIssueNode) => mapIssueNode(node));
        items.push(...mapped);

        if (!issues.pageInfo.hasNextPage || !issues.pageInfo.endCursor) {
            break;
        }

        after = issues.pageInfo.endCursor;
    }

    return items;
}

export async function listSubIssues(
    config: GitHubClientConfig,
    parentIssueId: string,
    options?: {pageSize?: number}
): Promise<GitHubIssueSummary[]> {
    const pageSize = Math.max(1, Math.min(options?.pageSize ?? DEFAULT_PAGE_SIZE, 100));

    const items: GitHubIssueSummary[] = [];
    let after: string | null = null;

    while (true) {
        const data: ListSubIssuesResponse = await graphql<ListSubIssuesResponse>(
            config,
            `query ListSubIssues($issueId: ID!, $first: Int!, $after: String) {
                node(id: $issueId) {
                    ... on Issue {
                        subIssues(first: $first, after: $after) {
                            nodes {
                                id
                                number
                                title
                                body
                                state
                                createdAt
                                closedAt
                                parent {
                                    id
                                    number
                                    title
                                }
                                labels(first: 50) {
                                    nodes {
                                        name
                                    }
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            }`,
            {
                issueId: parentIssueId,
                first: pageSize,
                after,
            }
        );

        const node = data.node;
        if (!node) {
            break;
        }

        const connection = node.subIssues;
        const mapped = (connection.nodes ?? [])
            .filter((item: RawIssueNode | null): item is RawIssueNode => Boolean(item))
            .map((item: RawIssueNode) => mapIssueNode(item));
        items.push(...mapped);

        if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
            break;
        }

        after = connection.pageInfo.endCursor;
    }

    return items;
}

export async function findChildIssueByExactTitle(
    config: GitHubClientConfig,
    params: {
        parentIssueId: string;
        title: string;
    }
): Promise<GitHubIssueSummary | null> {
    const children = await listSubIssues(config, params.parentIssueId);
    return children.find((issue) => issue.title === params.title) ?? null;
}

export async function ensureLabel(
    config: GitHubClientConfig,
    params: {
        name: string;
        color?: string;
        description?: string;
    }
): Promise<{id: string; name: string; color: string}> {
    const existing = await graphql<{
        repository: {
            label: {
                id: string;
                name: string;
                color: string;
            } | null;
        } | null;
    }>(
        config,
        `query FindLabel($owner: String!, $repo: String!, $name: String!) {
            repository(owner: $owner, name: $repo) {
                label(name: $name) {
                    id
                    name
                    color
                }
            }
        }`,
        {
            owner: config.owner,
            repo: config.repo,
            name: params.name,
        }
    );

    const existingLabel = existing.repository?.label;
    if (existingLabel) {
        return existingLabel;
    }

    const repositoryId = await getRepositoryId(config);
    const color = (params.color ?? "1D76DB").replace(/^#/, "").toUpperCase();

    const created = await graphql<{
        createLabel: {
            label: {
                id: string;
                name: string;
                color: string;
            };
        };
    }>(
        config,
        `mutation CreateLabel(
            $repositoryId: ID!,
            $name: String!,
            $color: String!,
            $description: String
        ) {
            createLabel(input: {
                repositoryId: $repositoryId,
                name: $name,
                color: $color,
                description: $description
            }) {
                label {
                    id
                    name
                    color
                }
            }
        }`,
        {
            repositoryId,
            name: params.name,
            color,
            description: params.description,
        }
    );

    return created.createLabel.label;
}

export async function addLabelsToIssue(
    config: GitHubClientConfig,
    issueId: string,
    labelIds: string[]
): Promise<void> {
    if (labelIds.length === 0) {
        return;
    }

    await graphql<{
        addLabelsToLabelable: {
            clientMutationId: string | null;
        };
    }>(
        config,
        `mutation AddLabelsToIssue($issueId: ID!, $labelIds: [ID!]!) {
            addLabelsToLabelable(input: {
                labelableId: $issueId,
                labelIds: $labelIds
            }) {
                clientMutationId
            }
        }`,
        {
            issueId,
            labelIds,
        }
    );
}

export async function markIssueInProgressWithLabel(
    config: GitHubClientConfig,
    issueId: string,
    labelName = "status:in-progress"
): Promise<{labelId: string}> {
    const label = await ensureLabel(config, {
        name: labelName,
        color: "1D76DB",
        description: "Workflow status: in progress",
    });
    await addLabelsToIssue(config, issueId, [label.id]);
    return {labelId: label.id};
}

function escapeSearchString(value: string): string {
    return value.replace(/"/g, '\\"');
}

async function searchIssues(
    config: GitHubClientConfig,
    queryText: string,
    options?: {pageSize?: number}
): Promise<GitHubIssueSummary[]> {
    const pageSize = Math.max(1, Math.min(options?.pageSize ?? DEFAULT_PAGE_SIZE, 100));

    const items: GitHubIssueSummary[] = [];
    let after: string | null = null;

    while (true) {
        const data: SearchIssuesResponse = await graphql<SearchIssuesResponse>(
            config,
            `query SearchIssues($query: String!, $first: Int!, $after: String) {
                search(query: $query, type: ISSUE, first: $first, after: $after) {
                    nodes {
                        ... on Issue {
                            id
                            number
                            title
                            body
                            state
                            createdAt
                            closedAt
                            parent {
                                id
                                number
                                title
                            }
                            labels(first: 50) {
                                nodes {
                                    name
                                }
                            }
                        }
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }`,
            {
                query: queryText,
                first: pageSize,
                after,
            }
        );

        const mapped = (data.search.nodes ?? [])
            .filter((node: RawIssueNode | null): node is RawIssueNode => Boolean(node))
            .map((node: RawIssueNode) => mapIssueNode(node));
        items.push(...mapped);

        if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) {
            break;
        }

        after = data.search.pageInfo.endCursor;
    }

    return items;
}

export async function listInProgressIssuesByLabel(
    config: GitHubClientConfig,
    labelName = "status:in-progress"
): Promise<GitHubIssueSummary[]> {
    const query = [
        `repo:${config.owner}/${config.repo}`,
        "is:issue",
        "is:open",
        `label:\"${escapeSearchString(labelName)}\"`,
    ].join(" ");

    return searchIssues(config, query);
}

