const assert = require("node:assert/strict");
const test = require("node:test");
const {
  GroqRouter,
  GroqQuotaError,
  GroqRoutingError,
} = require("../out/orchestrator/router.js");

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withFetchSequence(responses, callback) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra fetch call.");
    return response;
  };
  try {
    return await callback(requests);
  } finally {
    global.fetch = originalFetch;
  }
}

test("Groq router retries failed JSON generation without structured output", async () => {
  await withFetchSequence(
    [
      jsonResponse(400, {
        error: {
          message: "Failed to generate JSON. Please adjust your prompt.",
          code: "failed_generation",
          failed_generation: "not json",
        },
      }),
      jsonResponse(200, {
        choices: [{ message: { content: '{"agent":"codex"}' } }],
      }),
    ],
    async (requests) => {
      const decision = await new GroqRouter("test-key", "test-model").route("Implement a retry.");
      assert.deepEqual(decision, { agent: "codex" });
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].response_format, { type: "json_object" });
      assert.equal(requests[1].response_format, undefined);
    }
  );
});

test("Groq router marks repeated failed generation as fallback-eligible", async () => {
  await withFetchSequence(
    [
      jsonResponse(400, { error: { message: "Failed to generate JSON.", code: "failed_generation" } }),
      jsonResponse(400, { error: { message: "Failed to generate JSON.", code: "failed_generation" } }),
    ],
    async () => {
      await assert.rejects(
        new GroqRouter("test-key", "test-model").route("Analyze permissions."),
        GroqRoutingError
      );
    }
  );
});

test("Groq router does not hide authentication errors behind fallback", async () => {
  await withFetchSequence(
    [jsonResponse(401, { error: { message: "Invalid API key.", code: "invalid_api_key" } })],
    async () => {
      await assert.rejects(
        new GroqRouter("bad-key", "test-model").route("Implement feature."),
        (error) =>
          !(error instanceof GroqRoutingError) &&
          !(error instanceof GroqQuotaError) &&
          /HTTP 401/.test(error.message)
      );
    }
  );
});

test("Groq router treats malformed successful output as fallback-eligible", async () => {
  await withFetchSequence(
    [jsonResponse(200, { choices: [{ message: { content: "codex" } }] })],
    async () => {
      await assert.rejects(
        new GroqRouter("test-key", "test-model").route("Fix tests."),
        GroqRoutingError
      );
    }
  );
});
