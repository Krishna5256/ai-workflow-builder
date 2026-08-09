"use client";

import { useState } from "react";

type Step = {
  id: number;
  type: string;
  name: string;
  status: string;
};

const stepTypes = [
  "llm_call",
  "http_request",
  "conditional_branch",
  "approval_gate",
  "db_write",
  "notify",
];

export default function Home() {
  const [steps, setSteps] = useState<Step[]>([
    { id: 1, type: "llm_call", name: "Analyze input", status: "pending" },
    { id: 2, type: "http_request", name: "Fetch API data", status: "pending" },
    { id: 3, type: "conditional_branch", name: "Check result", status: "pending" },
    { id: 4, type: "approval_gate", name: "Owner approval", status: "pending" },
  ]);

  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [quotaUsed, setQuotaUsed] = useState(3);
  const quotaAllowed = 100;

  function addStep() {
    const type = stepTypes[steps.length % stepTypes.length];

    setSteps([
      ...steps,
      {
        id: Date.now(),
        type,
        name: type.replaceAll("_", " "),
        status: "pending",
      },
    ]);
  }

  async function runWorkflow() {
    setRunning(true);
    setPaused(false);

    for (let i = 0; i < steps.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 900));

      setSteps((current) =>
        current.map((step, index) =>
          index === i ? { ...step, status: "running" } : step
        )
      );

      await new Promise((resolve) => setTimeout(resolve, 700));

      if (steps[i].type === "approval_gate") {
        setSteps((current) =>
          current.map((step, index) =>
            index === i ? { ...step, status: "paused" } : step
          )
        );
        setPaused(true);
        setRunning(false);
        return;
      }

      setSteps((current) =>
        current.map((step, index) =>
          index === i ? { ...step, status: "completed" } : step
        )
      );
    }

    setQuotaUsed((value) => value + 1);
    setRunning(false);
  }

  function approveStep() {
    setPaused(false);
    setRunning(true);

    setSteps((current) =>
      current.map((step) =>
        step.type === "approval_gate"
          ? { ...step, status: "approved" }
          : step
      )
    );

    setTimeout(() => {
      setSteps((current) =>
        current.map((step) =>
          step.type === "approval_gate"
            ? { ...step, status: "completed" }
            : step
        )
      );

      setQuotaUsed((value) => value + 1);
      setRunning(false);
    }, 1200);
  }

  function statusClass(status: string) {
    if (status === "completed" || status === "approved") return "success";
    if (status === "running") return "running";
    if (status === "paused") return "paused";
    return "pending";
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <div className="brand">AI Workflow Builder</div>
          <div className="subtitle">
            Build, run and monitor AI agent workflows
          </div>
        </div>

        <div className="org">
          <span className="org-dot" />
          Organization A
          <span className="role">OWNER</span>
        </div>
      </header>

      <section className="content">
        <div className="hero">
          <div>
            <h1>Customer Intelligence Workflow</h1>
            <p>
              AI-powered workflow with external API calls, branching and
              approval control.
            </p>
          </div>

          <div className="actions">
            <button className="secondary" onClick={addStep}>
              + Add Step
            </button>

            <button
              className="primary"
              onClick={runWorkflow}
              disabled={running || paused}
            >
              {running ? "Running..." : paused ? "Awaiting Approval" : "▶ Run"}
            </button>
          </div>
        </div>

        <div className="grid">
          <section className="card workflow-card">
            <div className="card-header">
              <div>
                <h2>Workflow Steps</h2>
                <span>{steps.length} steps</span>
              </div>

              <div className="trigger">
                <span>TRIGGER</span>
                Manual + Webhook
              </div>
            </div>

            <div className="steps">
              {steps.map((step, index) => (
                <div className="step-row" key={step.id}>
                  <div className="step-number">{index + 1}</div>

                  <div className="step-icon">
                    {step.type === "llm_call" && "AI"}
                    {step.type === "http_request" && "↗"}
                    {step.type === "conditional_branch" && "◆"}
                    {step.type === "approval_gate" && "✓"}
                    {step.type === "db_write" && "DB"}
                    {step.type === "notify" && "!"}
                  </div>

                  <div className="step-info">
                    <strong>{step.name}</strong>
                    <small>{step.type}</small>
                  </div>

                  <span className={`status ${statusClass(step.status)}`}>
                    {step.status}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <aside className="side-column">
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>Usage</h2>
                  <span>This billing period</span>
                </div>
                <strong>
                  {quotaUsed}/{quotaAllowed}
                </strong>
              </div>

              <div className="progress">
                <div
                  style={{
                    width: `${(quotaUsed / quotaAllowed) * 100}%`,
                  }}
                />
              </div>

              <p className="muted">
                {quotaAllowed - quotaUsed} workflow calls remaining
              </p>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <h2>Triggers</h2>
                  <span>Start this workflow</span>
                </div>
              </div>

              <div className="trigger-list">
                <div>
                  <b>Manual</b>
                  <span>Enabled</span>
                </div>

                <div>
                  <b>Webhook</b>
                  <span>Enabled</span>
                </div>

                <div>
                  <b>Scheduled</b>
                  <span>Not configured</span>
                </div>
              </div>
            </section>
          </aside>
        </div>

        {paused && (
          <section className="approval">
            <div>
              <div className="approval-title">⏸ Approval required</div>
              <p>
                This workflow is paused at the approval gate. Only an owner
                or editor from this organization can continue it.
              </p>
            </div>

            <button className="primary" onClick={approveStep}>
              ✓ Approve & Continue
            </button>
          </section>
        )}

        <section className="card live">
          <div className="card-header">
            <div>
              <h2>Live Run Progress</h2>
              <span>Step status updates without refresh</span>
            </div>

            <span className="live-indicator">
              <i /> LIVE
            </span>
          </div>

          <div className="timeline">
            {steps.map((step, index) => (
              <div className="timeline-row" key={step.id}>
                <div
                  className={`timeline-dot ${statusClass(step.status)}`}
                />
                <div>
                  <strong>
                    Step {index + 1}: {step.name}
                  </strong>
                  <p>
                    {step.status === "pending" && "Waiting to execute"}
                    {step.status === "running" && "Executing step..."}
                    {step.status === "completed" && "Completed successfully"}
                    {step.status === "paused" &&
                      "Paused — awaiting approval"}
                    {step.status === "approved" &&
                      "Approved — resuming workflow"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
