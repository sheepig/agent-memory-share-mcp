export function humanReviewHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Qrels 人工校准台</title>
  <style>
    :root{color-scheme:light;--paper:#f7f8fa;--surface:#fff;--ink:#17202a;--muted:#66717d;--line:#d9dfe5;--blue:#315c88;--blue-soft:#eaf1f7;--green:#2e6b57;--green-soft:#e8f2ed;--orange:#a85d2a;--orange-soft:#f7ece4;--shadow:0 18px 50px rgba(34,48,63,.08)}
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    button{font:inherit}
    button:focus-visible{outline:3px solid rgba(49,92,136,.28);outline-offset:3px}
    .shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr}
    .topbar{background:var(--ink);color:#fff;padding:16px max(24px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:28px}
    .identity{display:flex;align-items:baseline;gap:12px;white-space:nowrap}
    .identity strong{font-size:17px;letter-spacing:.01em}.identity span{color:#b9c4ce;font-size:12px}
    .progress{flex:1;display:grid;grid-template-columns:auto minmax(120px,1fr) auto;align-items:center;gap:12px;font-size:12px;color:#d7dfe6}
    .track{height:4px;background:#43505d;overflow:hidden}.track span{display:block;height:100%;background:#88afd2;transition:width .2s ease}
    .save-state{min-width:70px;text-align:right;color:#cfe0d7}
    main{width:min(1180px,calc(100% - 48px));margin:34px auto 56px;display:grid;grid-template-columns:minmax(0,1fr) 255px;gap:24px;align-items:start}
    .workbench{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
    .query{padding:28px 34px 25px;border-bottom:1px solid var(--line)}
    .query-label,.evidence-label{margin:0 0 9px;color:var(--muted);font-size:12px}.query h1{font-size:25px;line-height:1.38;margin:0;font-weight:650;letter-spacing:-.018em;max-width:36em}
    .evidence{padding:28px 34px 34px;min-height:360px}
    .source{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:17px;color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .source span{overflow-wrap:anywhere}.evidence pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.75 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#263545}
    .score-panel{border-top:1px solid var(--line);padding:22px 34px 26px;background:#fbfcfd}
    .score-heading{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:13px}.score-heading strong{font-size:15px}.score-heading span{color:var(--muted);font-size:12px}
    .scores{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #aeb9c4}
    .score{appearance:none;border:0;border-right:1px solid #aeb9c4;background:#fff;min-height:78px;padding:10px 12px;color:var(--ink);cursor:pointer;display:grid;gap:2px;place-content:center;text-align:center}
    .score:last-child{border-right:0}.score:hover{background:var(--blue-soft)}.score.selected{background:var(--blue);color:#fff}.score kbd{font:700 24px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.score small{font-size:12px}
    .comparison{margin-top:14px;padding:12px 14px;display:flex;justify-content:space-between;gap:16px;align-items:center}.comparison.confirmed{background:var(--green-soft);color:var(--green)}.comparison.corrected{background:var(--orange-soft);color:var(--orange)}
    .comparison[hidden]{display:none}.comparison strong{font-size:13px}.comparison span{font-size:12px}
    aside{position:sticky;top:24px;border-top:3px solid var(--blue);background:#eef2f5;padding:21px}
    aside h2{font-size:15px;margin:0 0 14px}.rubric{margin:0;display:grid;grid-template-columns:25px 1fr;gap:10px 8px}.rubric dt{font:700 13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--blue)}.rubric dd{margin:0;color:#465462;font-size:12px;line-height:1.5}
    .nav{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:22px}.nav button{border:1px solid #aeb9c4;background:#fff;color:var(--ink);padding:9px;cursor:pointer}.nav button:disabled{cursor:not-allowed;opacity:.4}.nav button:hover:not(:disabled){border-color:var(--blue);color:var(--blue)}
    .case-position{text-align:center;color:var(--muted);font-size:12px;margin-top:12px}
    .empty{padding:70px 34px;text-align:center}.empty h1{font-size:24px;margin:0 0 8px}.empty p{color:var(--muted);margin:0}
    @media(max-width:800px){.topbar{align-items:flex-start;display:grid;gap:10px}.progress{grid-template-columns:auto 1fr}.save-state{grid-column:1/-1;text-align:left}main{grid-template-columns:1fr;width:min(100% - 24px,680px);margin-top:16px}aside{position:static}.query,.evidence,.score-panel{padding-left:20px;padding-right:20px}.scores{grid-template-columns:1fr 1fr}.score:nth-child(2){border-right:0}.score:nth-child(-n+2){border-bottom:1px solid #aeb9c4}}
    @media(prefers-reduced-motion:reduce){.track span{transition:none}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="identity"><strong>Qrels 人工校准台</strong><span id="reviewer"></span></div>
      <div class="progress"><span id="progress-text">载入中</span><div class="track"><span id="progress-bar"></span></div><span id="remaining"></span></div>
      <div class="save-state" id="save-state">读取数据</div>
    </header>
    <main id="main" hidden>
      <section class="workbench" aria-live="polite">
        <div class="query"><p class="query-label">检索问题</p><h1 id="query"></h1></div>
        <div class="evidence"><p class="evidence-label">候选证据</p><div class="source"><span id="session"></span><span id="location"></span><span id="modes"></span><span id="source-path"></span></div><pre id="evidence"></pre></div>
        <div class="score-panel">
          <div class="score-heading"><strong>这段证据能回答问题吗？</strong><span>按数字键 0–3 快速评分</span></div>
          <div class="scores" id="scores">
            <button class="score" data-score="0"><kbd>0</kbd><small>不相关</small></button>
            <button class="score" data-score="1"><kbd>1</kbd><small>略相关</small></button>
            <button class="score" data-score="2"><kbd>2</kbd><small>相关</small></button>
            <button class="score" data-score="3"><kbd>3</kbd><small>高度相关</small></button>
          </div>
          <div class="comparison" id="comparison" hidden><strong id="comparison-status"></strong><span id="comparison-detail"></span></div>
        </div>
      </section>
      <aside>
        <h2>评分标准</h2>
        <dl class="rubric"><dt>0</dt><dd>没有帮助，主题无关或无法支持答案。</dd><dt>1</dt><dd>存在弱关联，但缺少回答问题所需的关键信息。</dd><dt>2</dt><dd>包含回答问题的有效证据，但可能不完整。</dd><dt>3</dt><dd>直接、完整地支持问题的答案。</dd></dl>
        <div class="nav"><button id="previous">上一条</button><button id="next">下一条</button></div>
        <div class="case-position" id="case-position"></div>
      </aside>
    </main>
    <main class="empty" id="error" hidden><div><h1>无法载入标注任务</h1><p id="error-message"></p></div></main>
  </div>
  <script>
    const elements={main:document.getElementById("main"),error:document.getElementById("error"),errorMessage:document.getElementById("error-message"),reviewer:document.getElementById("reviewer"),progressText:document.getElementById("progress-text"),progressBar:document.getElementById("progress-bar"),remaining:document.getElementById("remaining"),saveState:document.getElementById("save-state"),query:document.getElementById("query"),session:document.getElementById("session"),location:document.getElementById("location"),modes:document.getElementById("modes"),sourcePath:document.getElementById("source-path"),evidence:document.getElementById("evidence"),scores:document.getElementById("scores"),comparison:document.getElementById("comparison"),comparisonStatus:document.getElementById("comparison-status"),comparisonDetail:document.getElementById("comparison-detail"),previous:document.getElementById("previous"),next:document.getElementById("next"),casePosition:document.getElementById("case-position")};
    let state;let index=0;let saving=false;
    function render(){const item=state.cases[index];elements.reviewer.textContent="审核人："+state.reviewer;elements.progressText.textContent=state.completed+" / "+state.total+" 已完成";elements.progressBar.style.width=(state.total?state.completed/state.total*100:0)+"%";elements.remaining.textContent="剩余 "+(state.total-state.completed);elements.query.textContent=item.query;elements.session.textContent=item.evidence.sessionId;elements.location.textContent=item.evidence.location+(item.evidence.endLocation&&item.evidence.endLocation!==item.evidence.location?" – "+item.evidence.endLocation:"");elements.modes.textContent=item.evidence.modes.join(" / ");elements.sourcePath.textContent=item.evidence.sourcePath;elements.evidence.textContent=item.evidence.text;elements.casePosition.textContent="第 "+(index+1)+" 条，共 "+state.total+" 条";elements.previous.disabled=index===0;elements.next.disabled=index===state.cases.length-1;elements.scores.querySelectorAll("button").forEach(button=>button.classList.toggle("selected",Number(button.dataset.score)===item.humanRelevance));if(item.status){elements.comparison.hidden=false;elements.comparison.className="comparison "+item.status;elements.comparisonStatus.textContent=item.status==="confirmed"?"与 LLM 一致":"已纠正 LLM 分数";elements.comparisonDetail.textContent="人工 "+item.humanRelevance+" · LLM "+item.llmRelevance}else{elements.comparison.hidden=true}elements.saveState.textContent="已保存"}
    async function score(relevance){if(saving)return;saving=true;elements.saveState.textContent="保存中";try{const item=state.cases[index];const response=await fetch("/api/judgments/"+encodeURIComponent(item.auditId),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({relevance})});if(!response.ok)throw new Error((await response.json()).error||"保存失败");const result=await response.json();const wasComplete=typeof item.humanRelevance==="number";Object.assign(item,result);if(!wasComplete)state.completed+=1;render()}catch(error){elements.saveState.textContent="保存失败";elements.errorMessage.textContent=error instanceof Error?error.message:String(error)}finally{saving=false}}
    function move(delta){index=Math.max(0,Math.min(state.cases.length-1,index+delta));render()}
    elements.scores.addEventListener("click",event=>{const button=event.target.closest("button[data-score]");if(button)score(Number(button.dataset.score))});elements.previous.addEventListener("click",()=>move(-1));elements.next.addEventListener("click",()=>move(1));document.addEventListener("keydown",event=>{if(event.key>="0"&&event.key<="3")score(Number(event.key));else if(event.key==="ArrowLeft")move(-1);else if(event.key==="ArrowRight")move(1)});
    fetch("/api/review").then(response=>{if(!response.ok)throw new Error("读取标注任务失败");return response.json()}).then(value=>{state=value;const firstPending=state.cases.findIndex(item=>typeof item.humanRelevance!=="number");index=firstPending>=0?firstPending:0;elements.main.hidden=false;render()}).catch(error=>{elements.error.hidden=false;elements.errorMessage.textContent=error instanceof Error?error.message:String(error);elements.saveState.textContent="载入失败"});
  </script>
</body>
</html>`;
}
