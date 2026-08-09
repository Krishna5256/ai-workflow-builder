const { GraphQLClient, gql } = require("graphql-request");

const client = new GraphQLClient(process.env.NHOST_GRAPHQL_URL, {
  headers: {
    "x-hasura-admin-secret": process.env.NHOST_ADMIN_SECRET,
  },
});

const GET_STEP = gql`
  query GetStep($id: uuid!) {
    step_runs_by_pk(id: $id) {
      id
      status
      workflow_run_id
      workflow_run {
        id
        status
        workflow {
          id
          org_id
        }
      }
      workflow_step {
        id
        type
        position
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

const APPROVE_STEP = gql`
  mutation ApproveStep(
    $id: uuid!
    $approved_by: uuid!
  ) {
    update_step_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: "completed"
        approved_by: $approved_by
        approved_at: "now()"
      }
    ) {
      id
      status
    }
  }
`;

const RESUME_RUN = gql`
  mutation ResumeRun($id: uuid!) {
    update_workflow_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: "running"
      }
    ) {
      id
      status
    }
  }
`;

const GET_REMAINING_STEPS = gql`
  query GetRemainingSteps($workflow_id: uuid!, $position: Int!) {
    workflow_steps(
      where: {
        workflow_id: { _eq: $workflow_id }
        position: { _gt: $position }
      }
      order_by: { position: asc }
    ) {
      id
      position
      type
      config
    }
  }
`;

const GET_STEP_RUN = gql`
  query GetStepRun($run_id: uuid!, $step_id: uuid!) {
    step_runs(
      where: {
        workflow_run_id: { _eq: $run_id }
        workflow_step_id: { _eq: $step_id }
      }
      limit: 1
    ) {
      id
      output
    }
  }
`;

const UPDATE_STEP = gql`
  mutation UpdateStep(
    $id: uuid!
    $status: String!
    $output: jsonb
  ) {
    update_step_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: $status
        output: $output
      }
    ) {
      id
    }
  }
`;

const COMPLETE_RUN = gql`
  mutation CompleteRun($id: uuid!) {
    update_workflow_runs_by_pk(
      pk_columns: { id: $id }
      _set: {
        status: "completed"
        completed_at: "now()"
      }
    ) {
      id
      status
    }
  }
`;

async function executeStep(step, previousOutput) {
  if (step.type === "llm_call") {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      await new Promise((r) => setTimeout(r, 1000));

      return {
        text: `Approved run continued after: ${JSON.stringify(
          previousOutput || {}
        )}`,
        stubbed: true,
      };
    }

    const prompt =
      step.config?.prompt ||
      "Continue the workflow based on the previous output.";

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
                  text: `${prompt}\nPrevious output:\n${JSON.stringify(
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
      throw new Error(`LLM failed: ${response.status}`);
    }

    const data = await response.json();

    return {
      text:
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "No response",
    };
  }

  if (step.type === "http_request") {
    if (!step.config?.url) {
      throw new Error("http_request requires config.url");
    }

    const method = step.config.method || "GET";

    const response = await fetch(step.config.url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(step.config.headers || {}),
      },
      body:
        method === "GET"
          ? undefined
          : JSON.stringify(step.config.body || {}),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP failed: ${response.status}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  if (step.type === "conditional_branch") {
    const value =
      previousOutput?.text ??
      previousOutput?.result ??
      previousOutput;

    const expected = step.config?.equals || "";

    return {
      branch: String(value)
        .toLowerCase()
        .includes(String(expected).toLowerCase())
        ? "true"
        : "false",
    };
  }

  return previousOutput;
}

module.exports = async (req, res) => {
  try {
    const userId =
      req.headers["x-hasura-user-id"] ||
      req.headers["X-Hasura-User-Id"];

    const stepRunId = req.body?.input?.step_run_id;

    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    if (!stepRunId) {
      return res.status(400).json({
        message: "step_run_id is required",
      });
    }

    const { step_runs_by_pk: stepRun } =
      await client.request(GET_STEP, {
        id: stepRunId,
      });

    if (!stepRun) {
      return res.status(404).json({
        message: "Step run not found",
      });
    }

    if (stepRun.status !== "paused") {
      return res.status(400).json({
        message: "Step is not awaiting approval",
      });
    }

    if (stepRun.workflow_step.type !== "approval_gate") {
      return res.status(400).json({
        message: "This step is not an approval gate",
      });
    }

    const orgId = stepRun.workflow_run.workflow.org_id;

    const { org_members: members } =
      await client.request(GET_MEMBER, {
        org_id: orgId,
        user_id: userId,
      });

    const member = members[0];

    if (!member || !["owner", "editor"].includes(member.role)) {
      return res.status(403).json({
        message: "Only an owner or editor can approve this step",
      });
    }

    await client.request(APPROVE_STEP, {
      id: stepRunId,
      approved_by: userId,
    });

    await client.request(RESUME_RUN, {
      id: stepRun.workflow_run_id,
    });

    const { workflow_steps: remaining } =
      await client.request(GET_REMAINING_STEPS, {
        workflow_id: stepRun.workflow_run.workflow.id,
        position: stepRun.workflow_step.position,
      });

    let previousOutput = null;

    const previous = await client.request(GET_STEP_RUN, {
      run_id: stepRun.workflow_run_id,
      step_id: stepRun.workflow_step.id,
    });

    previousOutput = previous.step_runs[0]?.output || null;

    for (const step of remaining) {
      if (step.type === "approval_gate") {
        const result = await client.request(
          gql`
            query FindStepRun($run_id: uuid!, $step_id: uuid!) {
              step_runs(
                where: {
                  workflow_run_id: { _eq: $run_id }
                  workflow_step_id: { _eq: $step_id }
                }
                limit: 1
              ) {
                id
              }
            }
          `,
          {
            run_id: stepRun.workflow_run_id,
            step_id: step.id,
          }
        );

        await client.request(UPDATE_STEP, {
          id: result.step_runs[0].id,
          status: "paused",
          output: previousOutput,
        });

        await client.request(
          gql`
            mutation Pause($id: uuid!) {
              update_workflow_runs_by_pk(
                pk_columns: { id: $id }
                _set: { status: "paused" }
              ) {
                id
              }
            }
          `,
          { id: stepRun.workflow_run_id }
        );

        return res.status(200).json({
          workflow_run_id: stepRun.workflow_run_id,
          status: "paused",
        });
      }

      const result = await client.request(
        gql`
          query FindStepRun($run_id: uuid!, $step_id: uuid!) {
            step_runs(
              where: {
                workflow_run_id: { _eq: $run_id }
                workflow_step_id: { _eq: $step_id }
              }
              limit: 1
            ) {
              id
            }
          }
        `,
        {
          run_id: stepRun.workflow_run_id,
          step_id: step.id,
        }
      );

      const output = await executeStep(step, previousOutput);

      await client.request(UPDATE_STEP, {
        id: result.step_runs[0].id,
        status: "completed",
        output,
      });

      previousOutput = output;
    }

    await client.request(COMPLETE_RUN, {
      id: stepRun.workflow_run_id,
    });

    return res.status(200).json({
      workflow_run_id: stepRun.workflow_run_id,
      status: "completed",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: error.message || "Approval failed",
    });
  }
};
