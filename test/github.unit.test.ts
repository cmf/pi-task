import test from "node:test";
import assert from "node:assert/strict";

import {
    createIssue,
    findChildIssueByExactTitle,
    GitHubGraphQLError,
    listIssues,
    listOpenRootIssues,
    type GitHubClientConfig,
} from "../github.js";

const config: GitHubClientConfig = {
    owner: "owner",
    repo: "repo",
    token: "test-token",
    endpoint: "https://example.test/graphql",
};

test("listIssues throws GitHubGraphQLError with status for non-JSON error bodies", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        return new Response("<html>bad gateway</html>", {
            status: 502,
            headers: {"content-type": "text/html"},
        });
    }) as typeof fetch;

    try {
        await assert.rejects(
            () => listIssues(config, {states: ["OPEN"], pageSize: 10}),
            (error) => {
                assert.ok(error instanceof GitHubGraphQLError);
                assert.equal(error.status, 502);
                assert.match(error.message, /Non-JSON GitHub GraphQL response/);
                assert.match(error.message, /bad gateway/);
                return true;
            },
        );
        assert.equal(calls, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("listIssues retries transient GitHub GraphQL failures", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
            return new Response(JSON.stringify({errors: [{message: "temporary outage"}]}), {
                status: 503,
                headers: {"content-type": "application/json"},
            });
        }

        return new Response(JSON.stringify({
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: {hasNextPage: false, endCursor: null},
                    },
                },
            },
        }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;

    try {
        const issues = await listIssues(config, {states: ["OPEN"], pageSize: 10});
        assert.deepEqual(issues, []);
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("listIssues retries invalid JSON transient GitHub responses", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
            return new Response("not json", {
                status: 503,
                headers: {"content-type": "application/json"},
            });
        }

        return new Response(JSON.stringify({
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: {hasNextPage: false, endCursor: null},
                    },
                },
            },
        }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;

    try {
        const issues = await listIssues(config, {states: ["OPEN"], pageSize: 10});
        assert.deepEqual(issues, []);
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("createIssue does not retry an ambiguous transient mutation failure", async () => {
    const originalFetch = globalThis.fetch;
    const queries: string[] = [];
    globalThis.fetch = (async (_input, init) => {
        const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
        queries.push(query);

        if (/\bquery\b/i.test(query)) {
            return new Response(JSON.stringify({
                data: {repository: {id: "repository-id"}},
            }), {status: 200, headers: {"content-type": "application/json"}});
        }

        return new Response(JSON.stringify({errors: [{message: "temporary outage"}]}), {
            status: 503,
            headers: {"content-type": "application/json"},
        });
    }) as typeof fetch;

    try {
        await assert.rejects(
            () => createIssue({...config, endpoint: "https://create-issue.example.test/graphql"}, {title: "New issue"}),
            (error) => error instanceof GitHubGraphQLError && error.status === 503,
        );
        assert.equal(queries.filter((query) => /\bmutation\b/i.test(query)).length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("listOpenRootIssues uses a lightweight open-issue query and filters child issues", async () => {
    const originalFetch = globalThis.fetch;
    let query = "";
    globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        query = String(body.query ?? "");
        return new Response(JSON.stringify({
            data: {
                repository: {
                    issues: {
                        nodes: [
                            {
                                id: "root-id",
                                number: 1,
                                title: "Root issue",
                                state: "OPEN",
                                createdAt: "2026-06-01T00:00:00Z",
                                closedAt: null,
                                parent: null,
                                labels: {nodes: []},
                            },
                            {
                                id: "child-id",
                                number: 2,
                                title: "Child issue",
                                state: "OPEN",
                                createdAt: "2026-06-01T00:00:00Z",
                                closedAt: null,
                                parent: {id: "root-id", number: 1, title: "Root issue"},
                                labels: {nodes: []},
                            },
                        ],
                        pageInfo: {hasNextPage: false, endCursor: null},
                    },
                },
            },
        }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;

    try {
        const issues = await listOpenRootIssues(config, {pageSize: 10});
        assert.deepEqual(issues.map((issue) => issue.id), ["root-id"]);
        assert.doesNotMatch(query, /\n\s*body\s*\n/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("findChildIssueByExactTitle ignores closed children with matching titles", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({
            data: {
                node: {
                    subIssues: {
                        nodes: [
                            {
                                id: "closed-id",
                                number: 10,
                                title: "Fix parser",
                                body: "closed body",
                                state: "CLOSED",
                                createdAt: "2026-06-01T00:00:00Z",
                                closedAt: "2026-06-02T00:00:00Z",
                                parent: null,
                                labels: {nodes: []},
                            },
                            {
                                id: "open-id",
                                number: 11,
                                title: "Fix parser",
                                body: "open body",
                                state: "OPEN",
                                createdAt: "2026-06-03T00:00:00Z",
                                closedAt: null,
                                parent: null,
                                labels: {nodes: []},
                            },
                        ],
                        pageInfo: {hasNextPage: false, endCursor: null},
                    },
                },
            },
        }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;

    try {
        const found = await findChildIssueByExactTitle(config, {
            parentIssueId: "parent-id",
            title: "Fix parser",
        });

        assert.equal(found?.id, "open-id");
        assert.equal(calls.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
