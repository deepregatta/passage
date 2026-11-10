// Markup for the wind-barb map marker (kept out of the component: it is markup, not copy).
export function windArrowHtml(rotation, windKt, palette) {
  return `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
      <svg width="30" height="30" viewBox="0 0 30 30" style="transform:rotate(${rotation}deg);opacity:.85">
        <path d="M15 4 L15 24 M15 4 L10 11 M15 4 L20 11" stroke="${palette.wind}" stroke-width="2.4"
          fill="none" stroke-linecap="round"/>
      </svg>
      <span style="font:600 12px/16px ui-monospace,monospace;white-space:nowrap;color:${palette.wind};background:${palette.paper.DEFAULT}e6;
        padding:0 4px;border-radius:2px;margin-top:-4px">${Math.round(windKt)} kt</span>
    </div>`;
}
