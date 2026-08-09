const { GraphQLClient, gql } = require("graphql-request");

const client = new GraphQLClient(process.env.NHOST_GRAPHQL_URL, {
  headers: {
    "x-hasura-admin-secret": process.env.NHOST_ADMIN_SECRET,
  },
});

const GET_WORKFLOW = gql`
  query GetWorkflow($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      org_id
      name
      workflow_steps(order_by: { position: asc }) {
        id
        position
        type
        config
      }
    }
  }
`;

const GET_MEMBER = gql`
  query GetMember($org_id: uuid!, $user_id: uuid!) {
    org_members(
      where: {
        org_id: { _eq: $org_id }
        user_id: { _eq: $user_id }
      }
      limit: 1
    ) {
      role
    }
  }
`;

const GET_QUOTA = gql`
  query GetQuota($id: uuid!) {
    organizations_by_pk(id: $id) {
      id
      quota_allowed
      quota_used
    }
  }
`;

const CREATE_RUN = gql`
  mutation CreateRun($workflow_id: uuid!) {
    insert_workflow_runs_one(
      object: {
        workflow_id: $workflow_id
        status: "running"
      }
    ) {
      id
    }
  }
`;

const CREATE_STEP_RUNS = gql`
  mutation CreateStepRuns($objects: [step_runs_insert_input!]!) {
    insert_step_runs(objects: $objects) {
      returning {
        id
        workflow_step_id
      }
    }
  }
`;

const UPDATE_STEP = gql`
  mutation UpdateStep(
    $id: uuid!
    $status: String!
    $input: jsonb
    $output: jsonb
    $error: String
    $attempt_count: Int
  ) {
    update_step_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: $status
        input: $input
        output: $output
        error: $error
        attempt_count: $attempt_count
      }
    ) {
      id
    }
  }
`;

const UPDATE_RUN = gql`
  mutation UpdateRun($id: uuid!, $status: String!, $error: String) {
    update_workflow_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: $status
        completed_at: "now()"
        error: $error
      }
    ) {
      id
    }
  }
`;

const INCREMENT_QUOTA = gql`
  mutation IncrementQuota($id: uuid!) {
    update_organizations_by_pk(
      pk_columns: { id: $id }
      _inc: { quota_used: 1 }
    ) {
      id
      quota_used
    }
  }
`;

async function callLLM(config, previousOutput) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      text: `Demo LLM response for: ${
        config?.prompt || "workflow step"
      }`,
      stubbed: true,
    };
  }

  const prompt =
    config?.prompt ||
    "Analyze the previous workflow output and return a concise result.";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `${prompt}\n\nPrevious output:\n${JSON.stringify(
                  previousOutput
                )}`,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    text:
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No LLM response",
  };
}

async function callHttp(config) {
  if (!config?.url) {
    throw new Error("http_request step requires config.url");
  }

  const method = config.method || "GET";

  const response = await fetch(config.url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(config.headers || {}),
    },
    body:
      method === "GET"
        ? undefined
        : JSON.stringify(config.body || {}),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP request failed: ${response.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function executeStep(step, previousOutput) {
  switch (step.type) {
    case "llm_call":
      return callLLM(step.config, previousOutput);

    case "http_request":
      return callHttp(step.config);

    case "conditional_branch": {
      const expected = step.config?.equals || "";
      const actual =
        previousOutput?.text ??
        previousOutput?.result ??
        previousOutput;

      return {
        branch: String(actual)
          .toLowerCase()
          .includes(String(expected).toLowerCase())
          ? "true"
          : "false",
        previous: previousOutput,
      };
    }

    case "db_write":
      return {
        saved: true,
        message: "Database write step completed",
      };

    case "notify":
      return {
        notified: true,
        message: "Notification step completed",
      };

    default:
      return previousOutput;
  }
}

async function runStep(step, stepRunId, previousOutput) {
  let attempt = 0;
  let lastError;

  while (attempt < 2) {
    attempt++;

    try {
      await client.request(UPDATE_STEP, {
        id: stepRunId,
        status: "running",
        input: previousOutput || {},
        attempt_count: attempt,
      });

      const output = await executeStep(step, previousOutput);

      await client.request(UPDATE_STEP, {
        id: stepRunId,
        status: "completed",
        input: previousOutput || {},
        output,
        attempt_count: attempt,
      });

      return output;
    } catch (error) {
      lastError = error;

      await client.request(UPDATE_STEP, {
        id: stepRunId,
        status: attempt < 2 ? "running" : "failed",
        error: error.message,
        attempt_count: attempt,
      });

      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError;
}

module.exports = async (req, res) => {
  try {
    const userId =
      req.body?.session_variables?.["x-hasura-user-id"] ||
      req.headers["x-hasura-user-id"] ||
      req.headers["X-Hasura-User-Id"];

    const workflowId = req.body?.input?.workflow_id;

    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    if (!workflowId) {
      return res.status(400).json({
        message: "workflow_id is required",
      });
    }

    const { workflows_by_pk: workflow } =
      await client.request(GET_WORKFLOW, {
        id: workflowId,
      });

    if (!workflow) {
      return res.status(404).json({
        message: "Workflow not found",
      });
    }

    const { org_members: members } =
      await client.request(GET_MEMBER, {
        org_id: workflow.org_id,
        user_id: userId,
      });

    const member = members[0];

    if (!member || !["owner", "editor"].includes(member.role)) {
      return res.status(403).json({
        message: "You cannot trigger this workflow",
      });
    }

    const { organizations_by_pk: organization } =
      await client.request(GET_QUOTA, {
        id: workflow.org_id,
      });

    if (!organization) {
      return res.status(404).json({
        message: "Organization not found",
      });
    }

    if (organization.quota_used >= organization.quota_allowed) {
      return res.status(429).json({
        message: "Organization quota exhausted",
      });
    }

    const { insert_workflow_runs_one: run } =
      await client.request(CREATE_RUN, {
        workflow_id: workflow.id,
      });

    const stepObjects = workflow.workflow_steps.map((step) => ({
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      status: "pending",
    }));

    const { insert_step_runs: stepRuns } =
      await client.request(CREATE_STEP_RUNS, {
        objects: stepObjects,
      });

    const stepRunByStep = new Map(
      stepRuns.returning.map((item) => [
        item.workflow_step_id,
        item.id,
      ])
    );

    let previousOutput = null;

    for (const step of workflow.workflow_steps) {
      const stepRunId = stepRunByStep.get(step.id);

      if (step.type === "approval_gate") {
        await client.request(UPDATE_STEP, {
          id: stepRunId,
          status: "paused",
          input: previousOutput || {},
          attempt_count: 0,
        });

        await client.request(
          gql`
            mutation PauseRun($id: uuid!) {
              update_workflow_runs_by_pk(
                pk_columns: { id: $id }
                _set: { status: "paused" }
              ) {
                id
              }
            }
          `,
          { id: run.id }
        );

        return res.status(200).json({
          workflow_run_id: run.id,
          status: "paused",
          awaiting_approval: stepRunId,
        });
      }

      previousOutput = await runStep(
        step,
        stepRunId,
        previousOutput
      );
    }

    await client.request(UPDATE_RUN, {
      id: run.id,
      status: "completed",
    });

    await client.request(INCREMENT_QUOTA, {
      id: workflow.org_id,
    });

    return res.status(200).json({
      workflow_run_id: run.id,
      status: "completed",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: error.message || "Workflow execution failed",
    });
  }
};
