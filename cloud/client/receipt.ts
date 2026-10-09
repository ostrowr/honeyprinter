import type {ReceiptRecord} from '../shared/api.ts';

const PAPER_WIDTH = 230;
const PAGE_HEIGHT = 370;
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

export function drawReceipt(ctx: CanvasRenderingContext2D, receipt: ReceiptRecord | null) {
    ctx.fillStyle = '#f9f6ed'; ctx.fillRect(0, 0, PAPER_WIDTH, PAGE_HEIGHT);
    ctx.fillStyle = '#080c08'; ctx.textAlign = 'center';
    ctx.font = `700 20px ${MONO}`; ctx.fillText('HONEYPRINTER', PAPER_WIDTH / 2, 32);
    ctx.font = `600 10px ${MONO}`; ctx.fillText('INTERNET ACTIVITY RECEIPT', PAPER_WIDTH / 2, 49);
    const rule = (y: number) => {
      ctx.strokeStyle = '#676b5f'; ctx.lineWidth = .6; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(PAPER_WIDTH - 20, y); ctx.stroke(); ctx.setLineDash([]);
    };
    rule(64);
    if (!receipt) {
      ctx.font = `600 12px ${MONO}`;
      ['PAPER LOADED', '', 'Waiting for the next minute.', '', 'One receipt per minute.', 'A record of who stopped by.'].forEach((line, i) => ctx.fillText(line, PAPER_WIDTH / 2, 112 + i * 21));
      rule(271);
      ctx.font = `600 10px ${MONO}`; ctx.fillText('NO TRAFFIC RECORDED YET', PAPER_WIDTH / 2, 294);
    } else {
      ctx.font = `600 10px ${MONO}`;
      ctx.fillText(new Date(receipt.created_at_ms).toLocaleString([], {month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'}).toUpperCase(), PAPER_WIDTH / 2, 81);
      ctx.textAlign = 'left'; ctx.fillText(`RECEIPT ${String(receipt.id).padStart(4, '0')}`, 20, 100);
      ctx.textAlign = 'right'; ctx.fillText(`${receipt.counts.sources} SOURCE${receipt.counts.sources === 1 ? '' : 'S'}`, PAPER_WIDTH - 20, 100);
      rule(113);
      ctx.font = `600 13px ${MONO}`;
      const services = receipt.counts.services.slice(0, 4);
      services.forEach((service, i) => {
        ctx.textAlign = 'left'; ctx.fillText(service.service.toUpperCase(), 20, 137 + i * 18);
        ctx.textAlign = 'right'; ctx.fillText(String(service.count), PAPER_WIDTH - 20, 137 + i * 18);
      });
      if (receipt.counts.services.length > 4) {
        ctx.textAlign = 'left'; ctx.font = `600 10px ${MONO}`; ctx.fillText(`+ ${receipt.counts.services.length - 4} OTHER SERVICES`, 20, 209);
      }
      rule(220);
      ctx.textAlign = 'left'; ctx.font = `700 14px ${MONO}`; ctx.fillText('CONNECTIONS', 20, 242);
      ctx.textAlign = 'right'; ctx.fillText(String(receipt.counts.probes), PAPER_WIDTH - 20, 242);
      rule(255);
      ctx.textAlign = 'left'; ctx.font = `600 13px ${MONO}`;
      const lines = wrapText(ctx, receipt.summary.body, PAPER_WIDTH - 40, 4);
      lines.forEach((line, i) => ctx.fillText(line, 20, 274 + i * 17));
      ctx.font = `600 10px ${MONO}`; ctx.fillStyle = '#303629'; ctx.textAlign = 'center';
      ctx.fillText(receipt.summarizer === 'quiet' ? 'QUIET MINUTE' : receipt.summarizer === 'mock' ? 'MOCK SUMMARY' : 'AI SUMMARY', PAPER_WIDTH / 2, 344);
    }
    // Perforation between receipts; all marks stay attached to the moving paper.
    ctx.fillStyle = '#b9b7aa';
    for (let x = 5; x < PAPER_WIDTH; x += 6) ctx.fillRect(x, PAGE_HEIGHT - 7, 2, .6);
  }

export function wrapText(ctx: {measureText(text: string): {width: number}}, text: string, width: number, maxLines: number) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width) { line = next; continue; }
    if (line) { lines.push(line); line = ''; }
    // IPv6 addresses and other long tokens must wrap, not clip at the paper edge.
    for (const character of word) {
      if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ''; }
      line += character;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, '') + '…';
  return lines.slice(0, maxLines);
}
