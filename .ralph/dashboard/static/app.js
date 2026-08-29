(() => {
  "use strict";

  const state = {
    snapshot: null,
    selectedRunId: "",
    followCurrent: true,
    selectedIteration: null,
    selectedStageId: "",
    expandedStageKey: "",
    tab: "stream",
    view: "execution",
    source: null,
    editingHistory: false,
    historySelection: new Set(),
  };

  const ids = [
    "app-shell", "connection", "top-task", "top-workspace", "top-branch", "run-count", "run-list",
    "history-edit", "history-edit-bar", "history-selection-count", "delete-selected-runs", "delete-all-runs",
    "run-status-label", "run-title", "run-subtitle", "progress-value", "progress-label", "progress-fill",
    "fact-iteration", "fact-score", "fact-started", "fact-ended", "fact-head", "fact-tree", "task-count",
    "task-list", "iteration-list", "detail-kicker", "detail-title", "detail-summary", "detail-model",
    "detail-attempt", "detail-artifact", "detail-content", "refresh", "operator-note-open",
    "operator-note-dialog", "operator-note-form", "operator-note-input", "operator-note-status",
    "operator-note-close", "operator-note-cancel", "execution-view", "usage-view", "usage-note", "usage-run-id",
    "usage-summary", "model-share-chart", "io-share-chart", "model-usage-list", "usage-call-list",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
  const palette = ["#5f7fff", "#35d08a", "#f0ad43", "#d56fff", "#4ec9d6", "#ff6f80", "#a7d45c"];

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }

  function formatAge(value) {
    if (!value) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}초 전`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
    return `${Math.floor(seconds / 86400)}일 전`;
  }

  function formatDuration(startedAt, completedAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
    const seconds = Math.round((end - start) / 1000);
    if (seconds < 60) return `${seconds}초`;
    return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  }

  function formatNumber(value) {
    return value === null || value === undefined ? "—" : new Intl.NumberFormat("ko-KR").format(value);
  }

  function statusLabel(status) {
    return ({
      running: "실행 중", passed: "통과", completed: "완료", failed: "실패", interrupted: "중단됨",
      retrying: "재시도", warning: "주의", pending: "대기", unknown: "기록 없음", checkpoint_failed: "Git 저장 실패",
      meta_failed: "Meta 실패", meta_invalid: "Meta 출력 오류", worker_failed: "Worker 실패",
      worker_fallback_exhausted: "Worker 폴백 소진", max_iterations_reached: "최대 반복 도달", preparing: "준비 중",
      needs_operator: "사용자 확인 필요",
    })[status] || status || "기록 없음";
  }

  function stageIcon(status) {
    return ({ completed: "✓", running: "●", warning: "!", failed: "×", pending: "·" })[status] || "·";
  }

  function stageExecutorLabel(stage) {
    return stage?.executorLabel || stage?.model?.displayLabel || "실행 정보 없음";
  }

  function taskSectionLabel(section) {
    return ({
      "작업 시작 시 재현 절차": "작업 전 확인사항",
      "재현 절차": "작업 전 확인사항",
    })[section] || section || "작업 계약";
  }

  function setConnection(kind, label) {
    elements.connection.className = `connection ${kind}${label === "LIVE" ? " active-run" : ""}`;
    elements.connection.querySelector("span").textContent = label;
  }

  function appendInlineCode(container, value) {
    const pieces = String(value || "").split(/(`[^`]+`)/g);
    for (const piece of pieces) {
      if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
        const code = document.createElement("code");
        code.textContent = piece.slice(1, -1);
        container.append(code);
      } else if (piece) {
        container.append(document.createTextNode(piece));
      }
    }
  }

  function selectedStage() {
    const snapshot = state.snapshot;
    if (!snapshot) return null;
    for (const iteration of snapshot.iterations || []) {
      for (const stage of iteration.stages || []) {
        if (iteration.number === state.selectedIteration && stage.id === state.selectedStageId) return { iteration, stage };
      }
    }
    return null;
  }

  function ensureSelection(snapshot) {
    if (selectedStage()) return;
    for (const iteration of [...(snapshot.iterations || [])].reverse()) {
      const active = (iteration.stages || []).find((stage) => stage.status === "running" || stage.status === "failed");
      if (active) {
        state.selectedIteration = iteration.number;
        state.selectedStageId = active.id;
        return;
      }
    }
    const latest = (snapshot.iterations || []).at(-1);
    const lastStarted = latest ? [...latest.stages].reverse().find((stage) => stage.status !== "pending") : null;
    state.selectedIteration = latest ? latest.number : null;
    state.selectedStageId = lastStarted ? lastStarted.id : "";
  }

  function renderRuns(snapshot) {
    const runs = snapshot.runs || [];
    const runIds = new Set(runs.map((run) => run.runId));
    state.historySelection = new Set([...state.historySelection].filter((runId) => runIds.has(runId)));
    const deletableRuns = runs.filter((run) => run.status !== "running");
    elements.run_count.textContent = String(runs.length);
    elements.run_list.replaceChildren();
    elements.history_edit.disabled = !runs.length;
    elements.history_edit.textContent = state.editingHistory ? "완료" : "편집";
    elements.history_edit_bar.hidden = !state.editingHistory;
    elements.history_selection_count.textContent = `${state.historySelection.size}개 선택`;
    elements.delete_selected_runs.disabled = !state.historySelection.size;
    elements.delete_all_runs.disabled = !deletableRuns.length;
    elements.delete_all_runs.title = snapshot.active
      ? "현재 실행 중인 기록을 제외하고 나머지를 모두 삭제합니다."
      : "이 저장소의 LOOP HISTORY를 모두 삭제합니다.";
    if (!runs.length) {
      state.editingHistory = false;
      state.historySelection.clear();
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "아직 Ralph 실행 기록이 없습니다.";
      elements.run_list.append(empty);
      return;
    }
    for (const run of runs) {
      const entry = document.createElement("div");
      entry.className = `run-entry${state.editingHistory ? " editing" : ""}`;
      const protectedRun = run.status === "running";
      if (state.editingHistory) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "run-checkbox";
        checkbox.checked = state.historySelection.has(run.runId);
        checkbox.disabled = protectedRun;
        checkbox.setAttribute("aria-label", `${run.taskLabel || run.task || run.runId} 실행 기록 선택`);
        checkbox.title = protectedRun ? "현재 실행 중인 기록은 삭제할 수 없습니다." : "삭제할 실행 기록을 선택합니다.";
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) state.historySelection.add(run.runId);
          else state.historySelection.delete(run.runId);
          renderRuns(snapshot);
        });
        entry.append(checkbox);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `run-item${state.selectedRunId === run.runId ? " active" : ""}`;
      button.dataset.status = run.status;
      const dot = document.createElement("i");
      dot.className = "run-dot";
      const copy = document.createElement("span");
      copy.className = "run-copy";
      const title = document.createElement("span");
      title.className = "run-title-row";
      const name = document.createElement("strong");
      name.className = "run-name";
      name.textContent = run.taskLabel || run.task || run.runId;
      name.title = name.textContent;
      const badge = document.createElement("em");
      badge.className = "run-status-badge";
      badge.textContent = statusLabel(run.status);
      title.append(name);
      const secondary = document.createElement("span");
      secondary.className = "run-secondary";
      const meta = document.createElement("span");
      meta.className = "run-meta";
      meta.textContent = `${formatDateTime(run.startedAt)}${run.score === null || run.score === undefined ? "" : ` · ${run.score}점`}`;
      const age = document.createElement("span");
      age.className = "run-time";
      age.textContent = formatAge(run.lastActivityAt || run.startedAt);
      secondary.append(meta, badge, age);
      copy.append(title, secondary);
      button.append(dot, copy);
      button.addEventListener("click", () => {
        if (!state.editingHistory) {
          selectRun(run.runId);
          return;
        }
        if (protectedRun) return;
        if (state.historySelection.has(run.runId)) state.historySelection.delete(run.runId);
        else state.historySelection.add(run.runId);
        renderRuns(snapshot);
      });
      entry.append(button);
      elements.run_list.append(entry);
    }
  }

  function renderOverview(snapshot) {
    const run = snapshot.run;
    elements.top_task.textContent = run ? (run.taskLabel || run.task) : "실행 대기";
    elements.top_workspace.textContent = snapshot.workspace?.name || "—";
    elements.top_branch.textContent = run?.branch || snapshot.workspace?.branch || snapshot.git?.branch || "—";
    elements.run_status_label.textContent = run ? statusLabel(run.status) : "NO ACTIVE RUN";
    elements.run_status_label.dataset.status = run?.status || "unknown";
    elements.run_title.textContent = run ? (run.taskLabel || run.task) : "Ralph 실행을 기다리고 있습니다";
    elements.run_subtitle.textContent = run
      ? `실행 ID ${run.runId} · 기준 commit ${run.baselineCommit ? String(run.baselineCommit).slice(0, 8) : "—"} · 통과 기준 ${run.minimumCriticScore ?? "—"}점`
      : "대시보드를 먼저 켠 뒤 Ralph Loop를 실행해도 자동으로 연결됩니다.";

    const stages = (snapshot.iterations || []).flatMap((iteration) => iteration.stages || []);
    const completed = stages.filter((stage) => stage.status === "completed").length;
    const total = stages.length;
    const percent = total ? Math.round((completed / total) * 100) : 0;
    elements.progress_value.textContent = `${percent}%`;
    elements.progress_label.textContent = `${completed} / ${total} 단계 정상 완료`;
    elements.progress_fill.style.width = `${percent}%`;
    const latest = (snapshot.iterations || []).at(-1);
    elements.fact_iteration.textContent = latest ? `${latest.number} / ${run?.maxIterations ?? "?"}` : "—";
    elements.fact_score.textContent = latest?.score === null || latest?.score === undefined ? "—" : `${latest.score} / 100`;
    elements.fact_started.textContent = formatDateTime(run?.startedAt);
    elements.fact_ended.textContent = snapshot.active ? "아직 실행 중" : formatDateTime(run?.endedAt || run?.lastActivityAt);
    elements.fact_head.textContent = snapshot.git?.head || "—";
    elements.fact_tree.textContent = snapshot.git?.dirty ? `${(snapshot.git.status || []).length}개 파일 변경` : "깨끗함";
  }

  function renderTasks(snapshot) {
    const tasks = snapshot.tasks || [];
    elements.task_count.textContent = `${tasks.length}개 항목`;
    elements.task_list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "PROMPT.md에서 체크리스트나 구현 요구사항을 찾지 못했습니다.";
      elements.task_list.append(empty);
      return;
    }
    tasks.forEach((task, taskIndex) => {
      const row = document.createElement("div");
      row.className = "task-item";
      row.dataset.status = task.status;
      const icon = document.createElement("span");
      icon.className = "task-index";
      icon.textContent = task.status === "completed" ? "✓" : String(taskIndex + 1).padStart(2, "0");
      icon.title = task.status === "completed" ? "완료된 계약 항목" : `${taskIndex + 1}번째 계약 항목`;
      const copy = document.createElement("div");
      const section = document.createElement("div");
      section.className = "task-section";
      section.textContent = taskSectionLabel(task.section);
      const text = document.createElement("div");
      text.className = "task-text";
      appendInlineCode(text, task.text);
      copy.append(section, text);
      row.append(icon, copy);
      elements.task_list.append(row);
    });
  }

  function eventPreview(events) {
    const list = document.createElement("div");
    list.className = "stage-event-preview";
    for (const event of (events || []).slice(-4)) {
      const row = document.createElement("div");
      const time = document.createElement("time");
      time.textContent = formatTime(event.timestamp);
      const message = document.createElement("span");
      message.textContent = event.summary || event.type;
      row.append(time, message);
      list.append(row);
    }
    return list;
  }

  function renderIterations(snapshot) {
    elements.iteration_list.replaceChildren();
    if (!(snapshot.iterations || []).length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = snapshot.run ? "이 실행에는 구조화된 단계 이벤트가 없습니다." : "Ralph를 실행하면 Iteration과 노드가 여기에 표시됩니다.";
      elements.iteration_list.append(empty);
      return;
    }
    for (const iteration of snapshot.iterations) {
      const section = document.createElement("section");
      section.className = "iteration";
      section.dataset.status = iteration.status;
      const header = document.createElement("div");
      header.className = "iteration-heading";
      const left = document.createElement("span");
      left.className = "iteration-title";
      left.textContent = `Iteration ${iteration.number}`;
      const iterationBadge = document.createElement("em");
      iterationBadge.className = "iteration-status";
      iterationBadge.textContent = statusLabel(iteration.status);
      left.append(iterationBadge);
      const right = document.createElement("span");
      const checkpoint = iteration.checkpoint || {};
      if (checkpoint.commit) {
        right.textContent = checkpoint.isRecovery
          ? `중단 전 안전 복구 지점 ${String(checkpoint.commit).slice(0, 8)} 저장`
          : `종료 복구 지점 ${String(checkpoint.commit).slice(0, 8)} 저장`;
      } else if (iteration.score !== null && iteration.score !== undefined) {
        right.textContent = `Critic ${iteration.score}점`;
      } else {
        right.textContent = "checkpoint 없음";
      }
      header.append(left, right);
      const list = document.createElement("div");
      list.className = "stage-list";
      for (const stage of iteration.stages) {
        const key = `${iteration.number}:${stage.id}`;
        const node = document.createElement("div");
        node.className = "stage-node";
        node.dataset.status = stage.status;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `stage-item${state.selectedIteration === iteration.number && state.selectedStageId === stage.id ? " selected" : ""}`;
        button.dataset.status = stage.status;
        button.setAttribute("aria-expanded", String(state.expandedStageKey === key));
        const icon = document.createElement("span");
        icon.className = "stage-icon";
        icon.textContent = stageIcon(stage.status);
        const title = document.createElement("span");
        title.className = "stage-title-row";
        const name = document.createElement("strong");
        name.className = "stage-name";
        name.textContent = stage.label;
        const badge = document.createElement("em");
        badge.className = "stage-status-badge";
        badge.textContent = statusLabel(stage.status);
        title.append(name, badge);
        const tail = document.createElement("span");
        tail.className = "stage-tail";
        tail.textContent = stage.score === null || stage.score === undefined
          ? stageExecutorLabel(stage)
          : `${stage.score}점${stage.id === "post_critic" && stage.verdict === "fail" ? " · 기준 미달" : stage.id === "pre_critic" ? " · 시작 평가" : ""}`;
        const chevron = document.createElement("span");
        chevron.className = "stage-chevron";
        chevron.textContent = state.expandedStageKey === key ? "−" : "+";
        button.append(icon, title, tail, chevron);
        button.addEventListener("click", () => {
          state.selectedIteration = iteration.number;
          state.selectedStageId = stage.id;
          state.expandedStageKey = state.expandedStageKey === key ? "" : key;
          renderIterations(state.snapshot);
          renderInspector(state.snapshot);
        });
        node.append(button);
        if (state.expandedStageKey === key) {
          const detail = document.createElement("div");
          detail.className = "stage-inline-detail";
          const summary = document.createElement("p");
          summary.textContent = stage.summary || stage.description;
          const facts = document.createElement("div");
          facts.className = "stage-inline-facts";
          const values = [
            ["실행 주체", stageExecutorLabel(stage)],
            ["시도", stage.attempt ? `${stage.attempt}회` : "해당 없음"],
            ["증거 파일", stage.artifact || "아직 없음"],
            ["최근 기록", formatDateTime(stage.timestamp)],
          ];
          for (const [label, value] of values) {
            const fact = document.createElement("span");
            const small = document.createElement("small");
            small.textContent = label;
            const strong = document.createElement("strong");
            strong.textContent = value;
            fact.append(small, strong);
            facts.append(fact);
          }
          detail.append(summary, facts, eventPreview(stage.events));
          node.append(detail);
        }
        list.append(node);
      }
      section.append(header, list);
      elements.iteration_list.append(section);
    }
  }

  function renderEventRows(events) {
    const fragment = document.createDocumentFragment();
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "이 단계의 이벤트가 아직 없습니다.";
      fragment.append(empty);
      return fragment;
    }
    for (const event of events) {
      const row = document.createElement("div");
      row.className = "event-row";
      row.dataset.status = event.status || "info";
      const time = document.createElement("time");
      time.textContent = formatTime(event.timestamp);
      const signal = document.createElement("span");
      signal.className = "event-signal";
      signal.textContent = event.status === "failed" ? "×" : ["completed", "passed", "success"].includes(event.status) ? "✓" : "·";
      const message = document.createElement("span");
      const prefix = [event.modelAlias, event.attempt ? `시도 ${event.attempt}` : ""].filter(Boolean).join(" · ");
      message.textContent = `${prefix ? `${prefix} — ` : ""}${event.summary || event.type}`;
      row.append(time, signal, message);
      fragment.append(row);
    }
    return fragment;
  }

  function criticAssessmentView(content) {
    let assessment;
    try {
      assessment = JSON.parse(content);
    } catch {
      return null;
    }
    if (!Array.isArray(assessment.criteria) || !assessment.criteria.length || assessment.score === undefined) return null;
    const view = document.createElement("div");
    view.className = "critic-assessment";
    const heading = document.createElement("div");
    heading.className = "critic-assessment-heading";
    const title = document.createElement("strong");
    title.textContent = `항목별 채점 · ${assessment.score} / 100`;
    const decision = document.createElement("span");
    decision.dataset.decision = assessment.decision || "retry";
    decision.textContent = ({ pass: "통과", retry: "재작업", needs_operator: "사용자 확인 필요" })[assessment.decision] || "판정 기록";
    heading.append(title, decision);
    const note = document.createElement("p");
    note.textContent = assessment.summary || `통과 기준은 ${assessment.threshold ?? "—"}점입니다.`;
    view.append(heading, note);
    const list = document.createElement("div");
    list.className = "criterion-list";
    for (const criterion of assessment.criteria) {
      const row = document.createElement("article");
      row.dataset.level = criterion.level || "absent";
      const rowHeading = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = criterion.label || criterion.id;
      const points = document.createElement("span");
      points.textContent = `${criterion.earned ?? 0} / ${criterion.weight ?? 0}점 · ${criterion.anchorLabel || criterion.level}`;
      rowHeading.append(label, points);
      const reason = document.createElement("p");
      reason.textContent = criterion.reason || "판정 이유가 없습니다.";
      const evidence = document.createElement("small");
      evidence.textContent = `증거: ${(criterion.evidence || []).join(" · ") || "없음"}`;
      row.append(rowHeading, reason, evidence);
      list.append(row);
    }
    view.append(list);
    if (Array.isArray(assessment.hardGates) && assessment.hardGates.length) {
      const gates = document.createElement("div");
      gates.className = "hard-gate-list";
      const gateTitle = document.createElement("strong");
      gateTitle.textContent = "Hard Gate";
      gates.append(gateTitle);
      for (const gate of assessment.hardGates) {
        const chip = document.createElement("span");
        chip.dataset.status = gate.status || "unknown";
        chip.textContent = `${gate.status === "pass" ? "통과" : gate.status === "fail" ? "실패" : "확인 필요"} · ${gate.label || gate.id}`;
        chip.title = gate.reason || "";
        gates.append(chip);
      }
      view.append(gates);
    }
    return view;
  }

  async function renderEvidence(runId, stage, container) {
    container.replaceChildren();
    if (!stage?.artifact || !runId) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "이 단계에 연결된 증거 파일이 아직 없습니다.";
      container.append(empty);
      return;
    }
    const loading = document.createElement("div");
    loading.className = "empty-list";
    loading.textContent = "증거 파일을 읽는 중…";
    container.append(loading);
    try {
      const response = await fetch(`/api/artifact?runId=${encodeURIComponent(runId)}&artifact=${encodeURIComponent(stage.artifact)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("증거 파일을 읽을 수 없습니다.");
      const payload = await response.json();
      const block = document.createElement("div");
      block.className = "artifact-block";
      const heading = document.createElement("div");
      heading.className = "artifact-heading";
      heading.textContent = `${payload.artifact} · ${formatNumber(payload.size)} bytes · ${formatDateTime(payload.updatedAt)}`;
      const pre = document.createElement("pre");
      pre.className = "artifact-content";
      pre.textContent = payload.content || "(빈 파일)";
      const assessment = criticAssessmentView(payload.content || "");
      if (assessment) {
        const raw = document.createElement("details");
        raw.className = "raw-evidence";
        const summary = document.createElement("summary");
        summary.textContent = "원본 JSON 보기";
        raw.append(summary, pre);
        block.append(heading, assessment, raw);
      } else {
        block.append(heading, pre);
      }
      container.replaceChildren(block);
    } catch (error) {
      loading.textContent = error.message;
    }
  }

  function renderGit(snapshot, container) {
    container.replaceChildren();
    const groups = [
      ["현재 변경 파일", snapshot.git?.status || ["변경 없음"], "status"],
      ["변경량", snapshot.git?.diffStat ? snapshot.git.diffStat.split("\n") : ["변경 요약 없음"], "diff"],
      ["Ralph 복구 지점", snapshot.git?.checkpoints?.length ? snapshot.git.checkpoints : ["아직 checkpoint가 없습니다."], "plain"],
    ];
    for (const [headingText, lines, kind] of groups) {
      const section = document.createElement("section");
      section.className = "git-section";
      const heading = document.createElement("h3");
      heading.textContent = headingText;
      section.append(heading);
      if (kind === "status") {
        const legend = document.createElement("div");
        legend.className = "git-legend";
        for (const [code, label, statusKind] of [["M", "수정", "modified"], ["A", "추가", "added"], ["D", "삭제", "deleted"], ["R", "이름 변경", "renamed"], ["??", "Git 추적 전 새 파일", "untracked"]]) {
          const item = document.createElement("span");
          item.dataset.kind = statusKind;
          const marker = document.createElement("b");
          marker.textContent = code;
          item.append(marker, document.createTextNode(label));
          legend.append(item);
        }
        section.append(legend);
      }
      for (const line of lines) {
        const row = document.createElement("div");
        row.className = "git-line";
        if (kind === "status" && /^..\s/.test(line)) {
          const code = line.slice(0, 2);
          const path = line.slice(3);
          const normalized = code.trim() || code;
          const statusKind = code === "??" ? "untracked"
            : /U|AA|DD/.test(code) ? "conflict"
              : code.includes("D") ? "deleted"
                : code.includes("A") ? "added"
                  : code.includes("R") ? "renamed"
                    : code.includes("C") ? "copied"
                      : code.includes("M") ? "modified" : "plain";
          const labels = { untracked: "Git 추적 전", conflict: "충돌", deleted: "삭제", added: "추가", renamed: "이름 변경", copied: "복사", modified: "수정" };
          const marker = document.createElement("b");
          marker.className = "git-status-code";
          marker.dataset.kind = statusKind;
          marker.textContent = normalized;
          const label = document.createElement("span");
          label.className = "git-status-label";
          label.dataset.kind = statusKind;
          label.textContent = labels[statusKind] || "상태";
          const file = document.createElement("code");
          file.textContent = path;
          row.append(marker, label, file);
        } else if (kind === "diff") {
          const statMatch = String(line).match(/^(.*\|\s+\d+\s+)([+-]+)$/);
          const pieces = statMatch ? [statMatch[1], statMatch[2]] : String(line).split(/(\(\+\)|\(-\))/g);
          for (const piece of pieces) {
            if (!piece) continue;
            const span = document.createElement("span");
            span.className = /^(\++|\(\+\))$/.test(piece) ? "git-addition" : /^(-+|\(-\))$/.test(piece) ? "git-deletion" : "";
            span.textContent = piece;
            row.append(span);
          }
        } else {
          row.textContent = line;
        }
        section.append(row);
      }
      container.append(section);
    }
  }

  function renderInspector(snapshot) {
    const selected = selectedStage();
    const stage = selected?.stage;
    elements.detail_kicker.textContent = stage ? `ITERATION ${selected.iteration.number} · ${statusLabel(stage.status)}` : "SELECT A NODE";
    elements.detail_title.textContent = stage?.label || "단계를 선택하세요";
    elements.detail_summary.textContent = stage?.summary || "파이프라인의 노드를 누르면 사용한 모델, 판단 요약과 증거를 확인할 수 있습니다.";
    elements.detail_model.textContent = stage ? stageExecutorLabel(stage) : "—";
    elements.detail_model.title = stage?.model?.modelId || "";
    elements.detail_attempt.textContent = stage?.attempt ? `${stage.attempt}회` : "해당 없음";
    elements.detail_artifact.textContent = stage?.artifact || "아직 없음";
    elements.detail_artifact.title = stage?.artifact || "";
    if (state.tab === "stream") {
      const events = stage?.events?.length ? stage.events : (snapshot.events || []).slice(-80);
      elements.detail_content.replaceChildren(renderEventRows(events));
      const live = snapshot.liveArtifact;
      if (live?.content && stage?.status === "running") {
        const block = document.createElement("div");
        block.className = "artifact-block";
        const heading = document.createElement("div");
        heading.className = "artifact-heading";
        heading.textContent = `실시간 출력 · ${live.artifact} · ${formatNumber(live.size)} bytes`;
        const pre = document.createElement("pre");
        pre.className = "artifact-content";
        pre.textContent = live.content;
        block.append(heading, pre);
        elements.detail_content.append(block);
      }
    } else if (state.tab === "evidence") {
      renderEvidence(snapshot.run?.runId, stage, elements.detail_content);
    } else {
      renderGit(snapshot, elements.detail_content);
    }
  }

  function summaryCard(label, value, note) {
    const card = document.createElement("article");
    const small = document.createElement("span");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const detail = document.createElement("p");
    detail.textContent = note;
    card.append(small, strong, detail);
    return card;
  }

  function renderDonut(container, values, centerValue, centerLabel) {
    container.replaceChildren();
    const total = values.reduce((sum, item) => sum + item.value, 0);
    if (!total) {
      const empty = document.createElement("div");
      empty.className = "chart-empty";
      empty.textContent = "공급자가 분리된 토큰 값을 제공한 호출이 아직 없습니다.";
      container.append(empty);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "donut-wrap";
    const chart = document.createElement("div");
    chart.className = "donut";
    let offset = 0;
    const stops = [];
    values.forEach((item, index) => {
      const start = offset;
      offset += (item.value / total) * 100;
      stops.push(`${item.color || palette[index % palette.length]} ${start}% ${offset}%`);
    });
    chart.style.background = `conic-gradient(${stops.join(",")})`;
    const center = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = centerValue;
    const small = document.createElement("span");
    small.textContent = centerLabel;
    center.append(strong, small);
    chart.append(center);
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    values.forEach((item, index) => {
      const row = document.createElement("div");
      const dot = document.createElement("i");
      dot.style.backgroundColor = item.color || palette[index % palette.length];
      const name = document.createElement("span");
      name.textContent = item.label;
      const amount = document.createElement("strong");
      amount.textContent = `${formatNumber(item.value)} · ${Math.round(item.value / total * 100)}%`;
      row.append(dot, name, amount);
      legend.append(row);
    });
    wrap.append(chart, legend);
    container.append(wrap);
  }

  function renderUsage(snapshot) {
    const usage = snapshot.usage || { totals: {}, models: [], calls: [] };
    const totals = usage.totals || {};
    elements.usage_run_id.textContent = snapshot.run ? `실행 ID ${snapshot.run.runId}` : "실행을 선택하세요";
    elements.usage_note.textContent = usage.note || "선택한 실행에서 각 모델이 담당한 단계와 공급자가 보고한 토큰을 집계합니다.";
    const splitCalls = totals.exactCalls || 0;
    const totalCalls = totals.calls || 0;
    const splitCoverageLabel = `${formatNumber(splitCalls)}/${formatNumber(totalCalls)}회에서 입·출력 분리`;
    elements.usage_summary.replaceChildren(
      summaryCard("모델 호출", `${formatNumber(totalCalls)}회`, splitCoverageLabel),
      summaryCard("총 토큰", formatNumber(totals.totalTokens || 0), `${formatNumber(totals.knownTotalCalls || 0)}회에서 확인`),
      summaryCard(
        "입력 토큰",
        splitCalls ? formatNumber(totals.inputTokens || 0) : "—",
        splitCalls ? `캐시 입력 ${formatNumber(totals.cachedInputTokens || 0)} · ${splitCoverageLabel}` : "총량만 있어 분리값 없음",
      ),
      summaryCard(
        "출력 토큰",
        splitCalls ? formatNumber(totals.outputTokens || 0) : "—",
        splitCalls ? `추론 출력 ${formatNumber(totals.reasoningOutputTokens || 0)} · ${splitCoverageLabel}` : "총량만 있어 분리값 없음",
      ),
    );
    renderDonut(
      elements.model_share_chart,
      (usage.models || []).filter((model) => model.totalTokens > 0).map((model, index) => ({
        label: model.model?.displayName || model.modelAlias, value: model.totalTokens, color: palette[index % palette.length],
      })),
      formatNumber(totals.totalTokens || 0),
      "확인된 총 토큰",
    );
    renderDonut(
      elements.io_share_chart,
      [
        { label: "입력", value: totals.inputTokens || 0, color: palette[0] },
        { label: "출력", value: totals.outputTokens || 0, color: palette[1] },
      ],
      formatNumber((totals.inputTokens || 0) + (totals.outputTokens || 0)),
      "분리 계측 토큰",
    );

    elements.model_usage_list.replaceChildren();
    if (!(usage.models || []).length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "이 실행에는 모델 호출 기록이 없습니다.";
      elements.model_usage_list.append(empty);
    }
    for (const model of usage.models || []) {
      const card = document.createElement("article");
      card.className = "model-usage-card";
      const heading = document.createElement("div");
      heading.className = "model-usage-heading";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = model.model?.displayLabel || model.modelAlias;
      const id = document.createElement("code");
      id.textContent = model.model?.modelId || model.modelAlias;
      copy.append(name, id);
      const share = document.createElement("span");
      share.textContent = `${model.sharePercent}%`;
      heading.append(copy, share);
      const metrics = document.createElement("div");
      metrics.className = "model-metrics";
      const splitCoverage = model.exactCalls === model.calls
        ? "complete"
        : model.exactCalls > 0 ? "partial" : "total-only";
      const splitValue = (value) => splitCoverage === "complete"
        ? formatNumber(value)
        : splitCoverage === "partial" ? `${formatNumber(value)} (일부)` : "총량만 기록됨";
      const metricValues = [
        ["호출", `${model.calls}회`], ["입력", splitValue(model.inputTokens)],
        ["출력", splitValue(model.outputTokens)], ["총 토큰", formatNumber(model.totalTokens)],
      ];
      for (const [label, value] of metricValues) {
        const item = document.createElement("span");
        item.innerHTML = `<small></small><strong></strong>`;
        item.querySelector("small").textContent = label;
        item.querySelector("strong").textContent = value;
        metrics.append(item);
      }
      const tasks = document.createElement("div");
      tasks.className = "model-tasks";
      for (const task of model.tasks || []) {
        const chip = document.createElement("span");
        chip.textContent = task;
        tasks.append(chip);
      }
      const coverage = document.createElement("p");
      coverage.textContent = model.exactCalls === model.calls
        ? "모든 호출의 입·출력 토큰이 분리 계측되었습니다."
        : `${model.knownTotalCalls}/${model.calls}회 총량 확인 · ${model.exactCalls}/${model.calls}회 입·출력 분리`;
      card.append(heading, metrics, tasks, coverage);
      elements.model_usage_list.append(card);
    }

    elements.usage_call_list.replaceChildren();
    for (const call of usage.calls || []) {
      const row = document.createElement("article");
      row.className = "usage-call";
      row.dataset.status = call.status;
      const title = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = `Iteration ${call.iteration} · ${call.stageLabel}`;
      const model = document.createElement("span");
      model.textContent = call.model?.displayLabel || call.modelAlias;
      title.append(strong, model);
      const summary = document.createElement("p");
      summary.textContent = call.summary;
      const tokens = document.createElement("div");
      tokens.className = "usage-call-tokens";
      tokens.textContent = call.tokenDetail === "exact"
        ? `입력 ${formatNumber(call.inputTokens)} · 출력 ${formatNumber(call.outputTokens)} · 총 ${formatNumber(call.totalTokens)}`
        : call.tokenDetail === "total_only"
          ? call.usageSource === "legacy_cli_total"
            ? `총 ${formatNumber(call.totalTokens)} · 계측 전 CLI 로그는 총량만 기록`
            : `총 ${formatNumber(call.totalTokens)} · 공급자 또는 호출 도구가 분리값을 제공하지 않음`
          : "공급자 token usage 기록 없음";
      const meta = document.createElement("small");
      meta.textContent = `시도 ${call.attempt} · ${formatDuration(call.startedAt, call.completedAt)} · ${statusLabel(call.status)}`;
      row.append(title, summary, tokens, meta);
      elements.usage_call_list.append(row);
    }
    if (!(usage.calls || []).length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "모델 호출 내역이 없습니다.";
      elements.usage_call_list.append(empty);
    }
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    if (state.followCurrent && snapshot.run?.runId) state.selectedRunId = snapshot.run.runId;
    ensureSelection(snapshot);
    renderRuns(snapshot);
    renderOverview(snapshot);
    renderTasks(snapshot);
    renderIterations(snapshot);
    renderInspector(snapshot);
    renderUsage(snapshot);
    setConnection("live", snapshot.active ? "LIVE" : "CONNECTED");
  }

  async function fetchSnapshot(runId = state.selectedRunId) {
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const response = await fetch(`/api/snapshot${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("snapshot 요청 실패");
    render(await response.json());
  }

  function connect(runId = state.selectedRunId) {
    if (state.source) state.source.close();
    setConnection("", "연결 중");
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const source = new EventSource(`/api/events${query}`);
    state.source = source;
    source.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
    source.onerror = () => setConnection("offline", "재연결 중");
    source.onopen = () => setConnection("live", "CONNECTED");
  }

  function selectRun(runId) {
    state.followCurrent = false;
    state.selectedRunId = runId;
    state.selectedIteration = null;
    state.selectedStageId = "";
    state.expandedStageKey = "";
    connect(runId);
  }

  function selectView(view) {
    state.view = view;
    elements.app_shell.dataset.view = view;
    elements.execution_view.hidden = view !== "execution";
    elements.usage_view.hidden = view !== "usage";
    document.querySelectorAll(".view-switch button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  }

  document.querySelectorAll(".view-switch button").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
  document.querySelectorAll(".detail-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".detail-tabs button").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      state.tab = button.dataset.tab;
      if (state.snapshot) renderInspector(state.snapshot);
    });
  });

  elements.refresh.addEventListener("click", () => fetchSnapshot().catch(() => setConnection("offline", "OFFLINE")));
  elements.history_edit.addEventListener("click", () => {
    state.editingHistory = !state.editingHistory;
    state.historySelection.clear();
    if (state.snapshot) renderRuns(state.snapshot);
  });

  async function deleteHistoryRuns(runIds, mode) {
    if (!runIds.length) return;
    const confirmed = window.confirm(
      `${mode === "all" ? "실행 중인 기록을 제외한 모든" : "선택한"} LOOP HISTORY ${runIds.length}개를 삭제하시겠습니까?\n\n` +
      "모델 응답, Critic·Verifier 로그와 토큰 이력이 삭제됩니다. 코드와 Git 커밋은 삭제되지 않습니다."
    );
    if (!confirmed) return;
    elements.delete_selected_runs.disabled = true;
    elements.delete_all_runs.disabled = true;
    try {
      const response = await fetch("/api/runs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "실행 기록 삭제에 실패했습니다.");
      state.editingHistory = false;
      state.historySelection.clear();
      state.followCurrent = true;
      state.selectedRunId = "";
      state.selectedIteration = null;
      state.selectedStageId = "";
      state.expandedStageKey = "";
      connect("");
    } catch (error) {
      window.alert(error.message);
    } finally {
      if (state.snapshot) renderRuns(state.snapshot);
    }
  }

  elements.delete_selected_runs.addEventListener("click", () => {
    deleteHistoryRuns([...state.historySelection], "selected");
  });
  elements.delete_all_runs.addEventListener("click", () => {
    const runIds = (state.snapshot?.runs || []).filter((run) => run.status !== "running").map((run) => run.runId);
    deleteHistoryRuns(runIds, "all");
  });
  elements.operator_note_open.addEventListener("click", () => {
    elements.operator_note_status.textContent = "";
    elements.operator_note_dialog.showModal();
    elements.operator_note_input.focus();
  });
  const closeDialog = () => elements.operator_note_dialog.close();
  elements.operator_note_close.addEventListener("click", closeDialog);
  elements.operator_note_cancel.addEventListener("click", closeDialog);
  elements.operator_note_form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = elements.operator_note_input.value.trim();
    const status = elements.operator_note_status;
    status.className = "dialog-status";
    status.textContent = "저장 중…";
    try {
      const response = await fetch("/api/operator-note", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "저장 실패");
      status.textContent = "다음 노드에 적용할 메모를 저장했습니다.";
      elements.operator_note_input.value = "";
      window.setTimeout(closeDialog, 650);
    } catch (error) {
      status.className = "dialog-status error";
      status.textContent = error.message;
    }
  });

  fetchSnapshot("")
    .then(() => connect(""))
    .catch(() => {
      setConnection("offline", "OFFLINE");
      window.setTimeout(() => connect(""), 1200);
    });
})();
