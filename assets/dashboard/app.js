const $ = (selector) => document.querySelector(selector);
const state = { snapshot: null, selectedRun: null, projectRoot: null, usageScope: "run", edit: false, selected: new Set(), source: null };
const nodes = [
  ["pre-critic", "Pre-Critic", "현재 상태와 누락 증거를 독립적으로 평가합니다."],
  ["meta-prompter", "Meta-Prompter", "실패 증거를 다음 Worker의 실행 지시로 바꿉니다."],
  ["worker", "Worker", "승인된 범위 안에서 코드와 문서를 수정합니다."],
  ["verifier", "Verifier", "AI가 아닌 로컬 명령으로 테스트·린트·타입·빌드를 검사합니다."],
  ["post-critic", "Post-Critic", "변경 결과를 증거 기반으로 다시 평가합니다."],
  ["adjudicator", "경계 재심", "80~90점 또는 불명확한 Hard Gate만 독립적으로 재심합니다."],
  ["git-checkpoint", "Git checkpoint", "이터레이션 상태를 복구 가능한 로컬 커밋으로 저장합니다."],
];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const formatTime = (value) => value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—";
const badge = (status) => `<span class="badge ${escapeHtml(status)}">${({running:"실행 중",pass:"통과",completed:"완료",failed:"실패",warning:"주의",pending:"대기",needs_operator:"사용자 확인",interrupted:"중단됨",interrupted_partial:"부분 중단",exact:"정확한 값",unavailable:"조회 불가",auth_required:"인증 필요",stale:"오래된 값"})[status] || escapeHtml(status)}</span>`;
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2200); }
function apiUrl(path, parameters={}) { const url=new URL(path,location.origin); if(state.projectRoot)url.searchParams.set("project",state.projectRoot); for(const [key,value] of Object.entries(parameters))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value)); return `${url.pathname}${url.search}`; }
async function requestJson(path, options) { const response=await fetch(path,options); const data=await response.json(); if(!response.ok)throw new Error(data.error||`요청에 실패했습니다. (HTTP ${response.status})`); return data; }
function markdownInline(text) { return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"); }
function renderList(title, values) { return `<div class="contract-group"><h3>${title}</h3>${values?.length ? `<ul>${values.map((item) => `<li>${markdownInline(item)}</li>`).join("")}</ul>` : `<p class="muted">지정된 항목이 없습니다.</p>`}</div>`; }
function renderHeader(snapshot) {
  const run = snapshot.selected;
  $("#header-facts").innerHTML = [
    ["작업공간", snapshot.projectRoot], ["Git 브랜치", snapshot.branch], ["시작 시각", formatTime(run?.startedAt)], ["종료 시각", formatTime(run?.endedAt)],
  ].map(([label,value]) => `<div class="header-fact"><small>${label}</small><strong>${escapeHtml(value)}</strong></div>`).join("");
}
function renderHistory(snapshot) {
  $("#history-tools").classList.toggle("hidden", !state.edit);
  $("#edit-history").textContent = state.edit ? "완료" : "편집";
  $("#run-list").innerHTML = snapshot.runs.map((run) => `<div class="run-card ${run.id === snapshot.selected?.id ? "selected" : ""}" data-run="${escapeHtml(run.id)}">
    ${state.edit ? `<input type="checkbox" data-check="${escapeHtml(run.id)}" ${state.selected.has(run.id) ? "checked" : ""} ${run.status === "running" ? "disabled" : ""} aria-label="${escapeHtml(run.id)} 선택">` : "<span></span>"}
    <div><h3>${escapeHtml(run.taskType)} ${badge(run.status)}</h3><div class="run-meta">${escapeHtml(run.id)}<br>${formatTime(run.startedAt)}</div></div>
  </div>`).join("") || `<p class="muted">아직 로컬 실행 기록이 없습니다.</p>`;
}
function renderContract(contract) {
  if (!contract) { $("#contract").innerHTML = `<p class="muted">실행 기록에 연결된 계약이 없습니다.</p>`; return; }
  $("#contract").innerHTML = `<p class="contract-goal">${markdownInline(contract.goal)}</p><div class="contract-grid">
    ${renderList("포함 범위", contract.include)}${renderList("제외 범위", contract.exclude)}${renderList("구현 요구사항", contract.requirements)}${renderList("완료 기준", contract.acceptanceCriteria)}${renderList("검증 명령", contract.verifierCommands)}${renderList("필수 산출물", contract.requiredArtifacts)}
  </div>`;
}
function renderGit(snapshot){const stats=snapshot.gitLineStats||{};const rows=String(snapshot.gitStatus||"").split(/\r?\n/).filter(Boolean).map(line=>{const code=line.slice(0,2).trim()||"?";const path=line.slice(3).replace(/^"|"$/g,"");const kind=code==="??"?"unknown":code.includes("D")?"D":code.includes("A")?"A":"M";const count=stats[path];return `<div class="git-row"><span class="git-${kind}">${escapeHtml(code)}</span><strong>${escapeHtml(path)}</strong><span>${count?`<b class="git-plus">+${escapeHtml(count.added)}</b> <b class="git-minus">-${escapeHtml(count.deleted)}</b>`:""}</span></div>`;});$("#git-files").innerHTML=rows.join("")||'<p class="muted">현재 작업 트리에 파일 변경이 없습니다.</p>';}
function nodeState(node, events, run) {
  const aliases = node === "pre-critic" || node === "post-critic" ? ["critic", node] : [node, node.replace("-", "")];
  const relevant = events.filter((event) => aliases.includes(event.node));
  const last = relevant.at(-1);
  if (run?.status !== "running" && run?.currentNode === node) return { status:"failed", last };
  if (run?.currentNode === node && run?.status === "running") return { status:"running", last };
  if (!last) return { status:"pending" };
  if (["failed","interrupted_partial"].includes(last.status)) return { status:"failed", last };
  if (["warning","retry","needs_operator"].includes(last.status)) return { status:"warning", last };
  return { status:"completed", last };
}
function renderExecution(snapshot) {
  const run = snapshot.selected; const events = snapshot.events || [];
  $("#iteration-title").textContent = run ? `${run.taskType} · Iteration ${run.iteration}` : "실행을 선택해 주세요";
  $("#score").textContent = Number.isFinite(run?.score) ? `${run.score}점` : "";
  const modelAttempt = [...events].reverse().find((event) => event.type === "model_attempt");
  const checkpoint = [...events].reverse().find((event) => event.type === "checkpoint");
  $("#iteration-facts").innerHTML = [
    ["실행 주체", modelAttempt?.data?.modelId ? `${modelAttempt.data.displayName || modelAttempt.data.modelId} · ${modelAttempt.data.modelId} · ${modelAttempt.data.effort}` : "—"],
    ["시도", modelAttempt?.data?.attempt ?? "—"], ["증거 파일", `events.jsonl · ${events.length}개`], ["판단 상태", run?.verdict ?? run?.status ?? "—"], ["Git checkpoint", checkpoint?.data?.commit?.slice?.(0,12) ?? "—"],
  ].map(([label,value]) => `<div class="fact"><small>${label}</small><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#execution").innerHTML = nodes.map(([id,title,description]) => {
    const value = nodeState(id, events, run); const last = value.last;
    return `<details class="node"><summary><i class="dot ${value.status}"></i><span class="node-title">${title}</span><span class="node-message">${escapeHtml(last?.message || description)}</span><span class="node-time">${formatTime(last?.timestamp)}</span></summary><div class="node-detail">${escapeHtml(last ? JSON.stringify(last.data || {}, null, 2) : "아직 실행되지 않았습니다.")}</div></details>`;
  }).join("");
}
function renderUsage(rows) {
  const grouped = new Map();
  for (const row of rows) { const key = `${row.provider}/${row.modelId}`; const total = row.usage.totalTokens ?? (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0); const current = grouped.get(key) || { model:key, displayName:row.displayName, input:0, output:0, reasoning:0, cache:0, total:0, calls:0, hasInput:false, hasOutput:false }; if(row.usage.inputTokens!==undefined){current.input+=row.usage.inputTokens;current.hasInput=true;} if(row.usage.outputTokens!==undefined){current.output+=row.usage.outputTokens;current.hasOutput=true;} current.reasoning += row.usage.reasoningTokens ?? 0; current.cache += row.usage.cachedTokens ?? 0; current.total += total; current.calls += 1; grouped.set(key,current); }
  const data = [...grouped.values()].sort((a,b)=>b.total-a.total); const total = data.reduce((sum,row)=>sum+row.total,0); const colors=["#5ee0a0","#71b7ff","#f1c96b","#b6a1ff","#ff7d86"]; let cursor=0; const stops=data.map((row,index)=>{ const start=cursor; cursor += total ? row.total/total*100 : 0; return `${colors[index%colors.length]} ${start}% ${cursor}%`; });
  $("#usage-chart").style.background = stops.length ? `conic-gradient(${stops.join(",")})` : "#233c35";
  $("#usage-summary").innerHTML = `<div class="usage-total">${total.toLocaleString()} tokens</div>${data.map((row,index)=>`<p><i class="dot" style="background:${colors[index%colors.length]}"></i>${escapeHtml(row.displayName)} · ${total ? Math.round(row.total/total*100) : 0}%</p>`).join("") || '<p class="muted">구조화된 사용량 기록이 없습니다.</p>'}`;
  $("#usage-table").innerHTML = `<table><thead><tr><th>모델</th><th>호출</th><th>입력</th><th>출력</th><th>Reasoning</th><th>Cache</th><th>합계</th></tr></thead><tbody>${data.map((row)=>`<tr><td>${escapeHtml(row.displayName)}</td><td>${row.calls}</td><td>${row.hasInput ? row.input : "분리 불가"}</td><td>${row.hasOutput ? row.output : "분리 불가"}</td><td>${row.reasoning || "—"}</td><td>${row.cache || "—"}</td><td>${row.total}</td></tr>`).join("")}</tbody></table>`;
}
async function renderCapacity(refresh=false) {
  $("#capacity-list").innerHTML = `<p class="muted">조회 중입니다…</p>`;
  const data = await requestJson(apiUrl("/api/capacity",refresh?{refresh:1}:{}));
  $("#capacity-list").innerHTML = Object.entries(data).map(([id,value])=>{ const exact=value.status==="exact"; const min=value.kind==="subscription"&&value.windows?.length?Math.min(...value.windows.map((item)=>item.remainingPercent)):null; const balance=value.kind==="api_balance"&&value.balances?.length?value.balances.map((item)=>`${item.total} ${item.currency}`).join(", "):null; return `<article class="capacity-card"><h3>${escapeHtml(id)} ${badge(value.status)}</h3><div class="capacity-value">${min!==null?`${min}% 남음`:balance||"자동 조회 미지원"}</div>${min!==null?`<div class="meter"><span style="width:${min}%"></span></div>`:""}<p class="muted">${escapeHtml(value.detail||value.source)}</p>${exact&&value.windows?value.windows.map((item)=>`<p>${escapeHtml(item.label)}: ${item.remainingPercent}% · reset ${formatTime(item.resetsAt)}</p>`).join(""):""}</article>`; }).join("");
}
function render(snapshot) { state.snapshot=snapshot; renderHeader(snapshot); renderHistory(snapshot); renderContract(snapshot.contract); renderExecution(snapshot); renderGit(snapshot); if(state.usageScope==="run")renderUsage(snapshot.usage||[]); $("#live-state").classList.add("connected"); $("#live-state").innerHTML="<i></i> LIVE"; }
async function renderUsageScope(){renderUsage(await requestJson(apiUrl("/api/usage",{scope:state.usageScope,runId:state.usageScope==="run"?state.snapshot?.selected?.id:undefined})));}
async function selectRun(id) { state.selectedRun=id; state.source?.close(); render(await requestJson(apiUrl("/api/snapshot",{runId:id||undefined}))); if(state.usageScope!=="run")await renderUsageScope(); state.source=new EventSource(apiUrl("/api/events",{runId:id||undefined})); state.source.addEventListener("snapshot",event=>render(JSON.parse(event.data))); }
async function loadProjects(){const projects=await requestJson("/api/projects");state.projectRoot=projects[0]||null;$("#project-select").innerHTML=projects.map(project=>`<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`).join("");$("#project-picker").classList.toggle("hidden",projects.length<2);$("#usage-scope option[value=all]").disabled=projects.length<2;}
document.addEventListener("click", async (event)=>{ try { const target=event.target.closest("button,.run-card,input"); if(!target)return;
  if(target.matches(".tab")){ document.querySelectorAll(".tab,.view").forEach(el=>el.classList.remove("active")); target.classList.add("active"); $(`#${target.dataset.view}-view`).classList.add("active"); if(target.dataset.view==="capacity") await renderCapacity(); if(target.dataset.view==="models")await renderUsageScope(); }
  if(target.matches(".run-card")&&!state.edit) await selectRun(target.dataset.run);
  if(target.id==="edit-history"){state.edit=!state.edit;state.selected.clear();renderHistory(state.snapshot);}
  if(target.dataset.check){target.checked?state.selected.add(target.dataset.check):state.selected.delete(target.dataset.check);}
  if(target.id==="delete-selected"&&state.selected.size&&confirm("선택한 로컬 실행 증거를 삭제하시겠습니까? 코드와 Git 커밋은 유지됩니다.")){await requestJson(apiUrl("/api/history/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runIds:[...state.selected]})});state.selected.clear();await selectRun(null);toast("선택한 기록을 삭제했습니다.");}
  if(target.id==="delete-all"&&confirm("종료된 모든 로컬 실행 증거를 삭제하시겠습니까? 코드와 Git 커밋은 유지됩니다.")){await requestJson(apiUrl("/api/history/clear"),{method:"POST"});await selectRun(null);toast("종료된 기록을 모두 삭제했습니다.");}
  if(target.id==="stop-run"){await requestJson(apiUrl("/api/stop"),{method:"POST"});toast("안전 중단을 요청했습니다.");}
  if(target.id==="save-note"){await requestJson(apiUrl("/api/operator-note"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note:$("#operator-note").value})});toast("다음 노드용 메모를 저장했습니다.");}
  if(target.id==="refresh-capacity")await renderCapacity(true);
} catch(error) { toast(error instanceof Error ? error.message : String(error)); }});
document.addEventListener("change",async(event)=>{try{if(event.target.id==="project-select"){state.projectRoot=event.target.value;state.selectedRun=null;state.selected.clear();await selectRun(null);}if(event.target.id==="usage-scope"){state.usageScope=event.target.value;await renderUsageScope();}}catch(error){toast(error instanceof Error ? error.message : String(error));}});
loadProjects().then(()=>selectRun(null)).catch((error)=>toast(error.message));
