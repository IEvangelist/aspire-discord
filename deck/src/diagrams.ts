import { icon, type IconName } from './icons';

type DiagramNode = {
  id: string;
  title: string;
  detail: string[];
  icon: IconName;
  x: number;
  y: number;
  w: number;
  h: number;
  step: number;
  kind?: 'hub' | 'gate';
};

type DiagramEdge = {
  from: string;
  to: string;
  path: string | ((source: DiagramNode, target: DiagramNode) => string);
  step: number;
  label?: string;
  x?: number;
  y?: number;
  kind?: 'return' | 'telemetry' | 'context';
};

type Diagram = {
  title: string;
  description: string;
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  returnTitle?: string;
  returnNote?: string;
};

const centerY = (node: DiagramNode) => node.y + node.h / 2;

function centerline(source: DiagramNode, target: DiagramNode): string {
  if (centerY(source) !== centerY(target)) throw new Error(`Unaligned row: ${source.id} -> ${target.id}`);
  const rightward = source.x < target.x;
  return `M${rightward ? source.x + source.w : source.x} ${centerY(source)} H${rightward ? target.x : target.x + target.w}`;
}

const diagrams: Record<string, Diagram> = {
  system: {
    title: 'Aspirey Bot on one page',
    description: 'Discord users mention the Node.js bot. The bot runs a Copilot SDK agent session that calls Azure OpenAI for chat. The bot reads GitHub through read-only MCP tools and queries Azure AI Search. A separate .NET ingestion worker fetches published docs and a pinned source snapshot, embeds them with Azure OpenAI, and publishes the indexes that the bot searches.',
    width: 1280,
    height: 530,
    nodes: [
      { id: 'discord', title: 'Discord', detail: ['Mentions, buttons'], icon: 'chat', x: 10, y: 25, w: 250, h: 100, step: 0 },
      { id: 'bot', title: 'Node.js bot', detail: ['Gateway + guards'], icon: 'agent', x: 335, y: 25, w: 250, h: 100, step: 1, kind: 'hub' },
      { id: 'copilot', title: 'Copilot SDK', detail: ['Agent loop + tools'], icon: 'workflow', x: 670, y: 25, w: 270, h: 100, step: 2 },
      { id: 'openai', title: 'Azure OpenAI', detail: ['Chat, embeddings'], icon: 'cloud', x: 1025, y: 25, w: 250, h: 100, step: 2 },
      { id: 'github', title: 'GitHub', detail: ['Reads + issues'], icon: 'github', x: 10, y: 215, w: 240, h: 100, step: 3 },
      { id: 'search', title: 'Azure AI Search', detail: ['Versioned indexes'], icon: 'search', x: 670, y: 215, w: 270, h: 100, step: 3 },
      { id: 'docs', title: 'Docs + source', detail: ['Published + pinned'], icon: 'book', x: 335, y: 405, w: 250, h: 100, step: 4 },
      { id: 'ingestion', title: '.NET ingestion', detail: ['Chunk and embed'], icon: 'sync', x: 670, y: 405, w: 270, h: 100, step: 4 },
    ],
    edges: [
      { from: 'discord', to: 'bot', path: centerline, step: 1, label: 'ask', x: 298, y: 61 },
      { from: 'bot', to: 'copilot', path: centerline, step: 2, label: 'agent', x: 627, y: 61 },
      { from: 'copilot', to: 'openai', path: centerline, step: 2, label: 'chat', x: 982, y: 61 },
      { from: 'bot', to: 'github', path: 'M380 125 V265 H250', step: 3, label: 'MCP', x: 315, y: 251 },
      { from: 'bot', to: 'search', path: 'M540 125 V265 H670', step: 3, label: 'query', x: 605, y: 251 },
      { from: 'docs', to: 'ingestion', path: centerline, step: 4, label: 'fetch', x: 627, y: 441 },
      { from: 'ingestion', to: 'search', path: 'M805 405 V315', step: 4, label: 'publish', x: 862, y: 366 },
      { from: 'ingestion', to: 'openai', path: 'M940 455 H1150 V125', step: 4, label: 'embed', x: 1045, y: 441, kind: 'context' },
    ],
  },
  graph: {
    title: 'The AppHost resource graph',
    description: 'The TypeScript AppHost starts Qdrant, the .NET ingestion worker, and the Node.js bot. Ingestion publishes indexes to Qdrant and the bot waits for ingestion. Aspire secrets supply environment values to the bot. Ingestion and the bot send OTLP telemetry to the Aspire dashboard.',
    width: 1280,
    height: 480,
    nodes: [
      { id: 'apphost', title: 'TS AppHost', detail: ['Models every runtime', 'Orders startup + health'], icon: 'code', x: 20, y: 185, w: 320, h: 130, step: 0, kind: 'hub' },
      { id: 'qdrant', title: 'Qdrant', detail: ['Vector store + volume'], icon: 'database', x: 450, y: 20, w: 300, h: 100, step: 1 },
      { id: 'ingestion', title: '.NET ingestion', detail: ['Builds the indexes'], icon: 'package', x: 450, y: 200, w: 300, h: 100, step: 1 },
      { id: 'bot', title: 'Node.js bot', detail: ['Waits, then connects'], icon: 'agent', x: 450, y: 360, w: 300, h: 100, step: 1 },
      { id: 'secrets', title: 'Aspire secrets', detail: ['Tokens stay out of code'], icon: 'key', x: 20, y: 360, w: 320, h: 100, step: 2 },
      { id: 'dashboard', title: 'Aspire dashboard', detail: ['Logs, traces, metrics'], icon: 'graph', x: 930, y: 200, w: 330, h: 100, step: 3 },
    ],
    edges: [
      { from: 'apphost', to: 'qdrant', path: 'M340 250 H395 V70 H450', step: 1 },
      { from: 'apphost', to: 'ingestion', path: 'M340 250 H450', step: 1 },
      { from: 'apphost', to: 'bot', path: 'M340 250 H395 V385 H450', step: 1 },
      { from: 'ingestion', to: 'qdrant', path: 'M600 200 V120', step: 2, label: 'publish', x: 662, y: 164 },
      { from: 'bot', to: 'ingestion', path: 'M600 360 V300', step: 2, label: 'waitFor', x: 666, y: 336, kind: 'context' },
      { from: 'secrets', to: 'bot', path: 'M340 435 H450', step: 2, label: 'env', x: 395, y: 421 },
      { from: 'apphost', to: 'secrets', path: 'M180 315 V360', step: 2, kind: 'context' },
      { from: 'ingestion', to: 'dashboard', path: 'M750 250 H930', step: 3, label: 'OTLP', x: 840, y: 236, kind: 'telemetry' },
      { from: 'bot', to: 'dashboard', path: 'M750 410 H1095 V300', step: 3, label: 'OTLP', x: 920, y: 396, kind: 'telemetry' },
    ],
  },
  pipeline: {
    title: 'aspire deploy as a pipeline we own',
    description: 'aspire deploy runs a preflight, builds immutable images, stages a new slot with Discord disabled, runs live feature gates, cuts over a single Discord session, and retires the old slot. If cutover fails, the prior slot returns.',
    width: 1280,
    height: 530,
    returnTitle: 'Failure path',
    returnNote: 'If cutover fails, the prior slot returns and nothing is retired.',
    nodes: [
      { id: 'deploy', title: 'aspire deploy', detail: ['One entry point'], icon: 'rocket', x: 10, y: 25, w: 250, h: 100, step: 0 },
      { id: 'preflight', title: 'Preflight', detail: ['Clean tree + Bicep'], icon: 'checklist', x: 320, y: 25, w: 270, h: 100, step: 0, kind: 'gate' },
      { id: 'build', title: 'Build images', detail: ['Tagged by Git SHA'], icon: 'package', x: 650, y: 25, w: 270, h: 100, step: 0 },
      { id: 'stage', title: 'Stage new slot', detail: ['Discord disabled'], icon: 'container', x: 980, y: 25, w: 290, h: 100, step: 1 },
      { id: 'gates', title: 'Live gates', detail: ['GitHub, MCP, tables'], icon: 'shield', x: 980, y: 215, w: 290, h: 100, step: 1, kind: 'gate' },
      { id: 'cutover', title: 'Cut over', detail: ['One Discord session'], icon: 'sync', x: 650, y: 215, w: 270, h: 100, step: 2, kind: 'hub' },
      { id: 'retire', title: 'Retire old slot', detail: ['Only after success'], icon: 'server', x: 320, y: 215, w: 270, h: 100, step: 2 },
      { id: 'rollback', title: 'Roll back', detail: ['Prior slot returns'], icon: 'versions', x: 650, y: 405, w: 270, h: 100, step: 3 },
    ],
    edges: [
      { from: 'deploy', to: 'preflight', path: centerline, step: 0 },
      { from: 'preflight', to: 'build', path: centerline, step: 0 },
      { from: 'build', to: 'stage', path: centerline, step: 1 },
      { from: 'stage', to: 'gates', path: 'M1125 125 V215', step: 1 },
      { from: 'gates', to: 'cutover', path: centerline, step: 2 },
      { from: 'cutover', to: 'retire', path: centerline, step: 2 },
      { from: 'cutover', to: 'rollback', path: 'M785 315 V405', step: 3, label: 'if it fails', x: 862, y: 366, kind: 'return' },
    ],
  },
  agent: {
    title: 'One request through the agent',
    description: 'A mention passes allowlist, rate-limit, and input guards. Redacted, bounded context reaches a fresh agent session. The session prompts Azure OpenAI, which calls typed tools and receives their results. An answer gate requires citations before one Discord reply is sent.',
    width: 1280,
    height: 510,
    nodes: [
      { id: 'mention', title: 'Mention', detail: ['Allowlisted user'], icon: 'chat', x: 10, y: 25, w: 240, h: 100, step: 0 },
      { id: 'guard', title: 'Guards', detail: ['Limits + input rules'], icon: 'shield', x: 310, y: 25, w: 270, h: 100, step: 0, kind: 'gate' },
      { id: 'context', title: 'Context', detail: ['Redacted, capped'], icon: 'stack', x: 640, y: 25, w: 270, h: 100, step: 0 },
      { id: 'session', title: 'Agent session', detail: ['Fresh per request'], icon: 'agent', x: 970, y: 25, w: 300, h: 100, step: 1, kind: 'hub' },
      { id: 'model', title: 'Azure OpenAI', detail: ['Chooses tools + writes'], icon: 'cloud', x: 970, y: 205, w: 300, h: 100, step: 2 },
      { id: 'tools', title: 'Typed tools', detail: ['Docs, API, GitHub'], icon: 'tools', x: 970, y: 385, w: 300, h: 100, step: 2 },
      { id: 'gate', title: 'Answer gate', detail: ['Citations required'], icon: 'check', x: 640, y: 205, w: 270, h: 100, step: 3, kind: 'gate' },
      { id: 'reply', title: 'Discord reply', detail: ['Edited in place'], icon: 'broadcast', x: 310, y: 205, w: 270, h: 100, step: 3 },
    ],
    edges: [
      { from: 'mention', to: 'guard', path: centerline, step: 0 },
      { from: 'guard', to: 'context', path: centerline, step: 0 },
      { from: 'context', to: 'session', path: centerline, step: 1 },
      { from: 'session', to: 'model', path: 'M1120 125 V205', step: 2, label: 'prompt', x: 1178, y: 170 },
      { from: 'model', to: 'tools', path: 'M1090 305 V385', step: 2, label: 'call', x: 1052, y: 350 },
      { from: 'tools', to: 'model', path: 'M1150 385 V305', step: 2, label: 'result', x: 1210, y: 350, kind: 'context' },
      { from: 'model', to: 'gate', path: centerline, step: 3, label: 'draft', x: 940, y: 241 },
      { from: 'gate', to: 'reply', path: centerline, step: 3, label: 'send', x: 610, y: 241 },
    ],
  },
  boundary: {
    title: 'The model can propose. Code decides.',
    description: 'The model can call prepare_issue_draft, which saves a durable preview. Only the requester can approve it. Deterministic code re-checks policy, Key Vault signs the GitHub App JWT, and a one-repository token creates the issue.',
    width: 1280,
    height: 530,
    nodes: [
      { id: 'model', title: 'The model', detail: ['Can only propose'], icon: 'agent', x: 10, y: 25, w: 300, h: 100, step: 0 },
      { id: 'draft', title: 'prepare_issue_draft', detail: ['A preview, not a publish'], icon: 'pr', x: 445, y: 25, w: 370, h: 100, step: 0 },
      { id: 'preview', title: 'Durable preview', detail: ['Exact title + body'], icon: 'database', x: 940, y: 25, w: 330, h: 100, step: 1 },
      { id: 'approve', title: 'Requester approval', detail: ['Only the requester'], icon: 'check', x: 940, y: 215, w: 330, h: 100, step: 2, kind: 'gate' },
      { id: 'recheck', title: 'Policy re-check', detail: ['User, server, repo, expiry'], icon: 'shield', x: 445, y: 215, w: 370, h: 100, step: 3, kind: 'gate' },
      { id: 'sign', title: 'Key Vault signs', detail: ['The key never leaves'], icon: 'key', x: 10, y: 215, w: 300, h: 100, step: 4 },
      { id: 'create', title: 'GitHub issue', detail: ['One repo, issues only'], icon: 'github', x: 10, y: 405, w: 300, h: 100, step: 5 },
    ],
    edges: [
      { from: 'model', to: 'draft', path: centerline, step: 0, label: 'propose', x: 378, y: 61 },
      { from: 'draft', to: 'preview', path: centerline, step: 1, label: 'save', x: 877, y: 61 },
      { from: 'preview', to: 'approve', path: 'M1105 125 V215', step: 2, label: 'review', x: 1167, y: 176 },
      { from: 'approve', to: 'recheck', path: centerline, step: 3, label: 'approve', x: 877, y: 251 },
      { from: 'recheck', to: 'sign', path: centerline, step: 4, label: 'allowed', x: 378, y: 251 },
      { from: 'sign', to: 'create', path: 'M160 315 V405', step: 5, label: 'JWT', x: 204, y: 366 },
    ],
  },
  ingestion: {
    title: 'Ingestion builds memory off the hot path',
    description: 'Published docs and a pinned commit of the Aspire source feed ingestion. Roslyn parses the public API and XML docs. Content is chunked, embedded with Azure OpenAI, and written to staged index generations. One alias swap publishes docs and API together. On failure the build is rolled back and the last good index stays live. Azure AI Search serves the alias and the Node.js bot queries it.',
    width: 1280,
    height: 530,
    returnTitle: 'Failure path',
    returnNote: 'A failed build is aborted. The last usable index stays online.',
    nodes: [
      { id: 'docs', title: 'Published docs', detail: ['CLI or GitHub'], icon: 'book', x: 10, y: 25, w: 260, h: 100, step: 0 },
      { id: 'source', title: 'Pinned source', detail: ['One exact commit'], icon: 'repo', x: 10, y: 215, w: 260, h: 100, step: 0 },
      { id: 'chunk', title: 'Chunks', detail: ['Cleaned, capped'], icon: 'stack', x: 340, y: 25, w: 260, h: 100, step: 1 },
      { id: 'roslyn', title: 'Roslyn parser', detail: ['API + XML docs'], icon: 'code', x: 340, y: 215, w: 260, h: 100, step: 1 },
      { id: 'embed', title: 'Azure OpenAI', detail: ['Embedding batches'], icon: 'cloud', x: 680, y: 25, w: 270, h: 100, step: 2 },
      { id: 'stage', title: 'Staged index', detail: ['New generations'], icon: 'table', x: 1000, y: 25, w: 270, h: 100, step: 3 },
      { id: 'alias', title: 'Alias swap', detail: ['Docs + API together'], icon: 'sync', x: 1000, y: 215, w: 270, h: 100, step: 4, kind: 'gate' },
      { id: 'abort', title: 'Roll back', detail: ['Last index stays'], icon: 'versions', x: 680, y: 215, w: 270, h: 100, step: 4 },
      { id: 'bot', title: 'Node.js bot', detail: ['Queries the alias'], icon: 'agent', x: 680, y: 405, w: 270, h: 100, step: 5 },
      { id: 'search', title: 'Azure AI Search', detail: ['Live aliases'], icon: 'search', x: 1000, y: 405, w: 270, h: 100, step: 5 },
    ],
    edges: [
      { from: 'docs', to: 'chunk', path: centerline, step: 1 },
      { from: 'chunk', to: 'embed', path: centerline, step: 2 },
      { from: 'embed', to: 'stage', path: centerline, step: 3 },
      { from: 'source', to: 'roslyn', path: centerline, step: 1 },
      { from: 'roslyn', to: 'chunk', path: 'M470 215 V125', step: 1 },
      { from: 'stage', to: 'alias', path: 'M1135 125 V215', step: 4, label: 'commit', x: 1192, y: 176 },
      { from: 'stage', to: 'abort', path: 'M1050 125 V170 H815 V215', step: 4, label: 'on failure', x: 930, y: 156, kind: 'return' },
      { from: 'alias', to: 'search', path: 'M1135 315 V405', step: 5, label: 'points to', x: 1202, y: 366 },
      { from: 'bot', to: 'search', path: centerline, step: 5 },
    ],
  },
  trace: {
    title: 'One trace from Discord message to model call',
    description: 'A Discord request is the root span and records an outcome. The agent span is its child. Model spans appear when the runtime exports OTLP, as it does in development. Tool calls produce embedding and Azure AI Search spans. All spans share one trace ID and flow to the Aspire dashboard locally or Application Insights in Azure.',
    width: 1280,
    height: 510,
    nodes: [
      { id: 'request', title: 'Discord request', detail: ['Root span + outcome'], icon: 'chat', x: 10, y: 25, w: 360, h: 100, step: 0 },
      { id: 'agent', title: 'invoke_agent', detail: ['GenAI agent span'], icon: 'agent', x: 460, y: 25, w: 360, h: 100, step: 1, kind: 'hub' },
      { id: 'chat', title: 'Copilot runtime', detail: ['Model spans (dev OTLP)'], icon: 'workflow', x: 910, y: 25, w: 360, h: 100, step: 2 },
      { id: 'tool', title: 'Tool call', detail: ['Docs, API, GitHub'], icon: 'tools', x: 460, y: 215, w: 360, h: 100, step: 2 },
      { id: 'embed', title: 'Embeddings', detail: ['Tokens + dimensions'], icon: 'stack', x: 910, y: 215, w: 360, h: 100, step: 3 },
      { id: 'search', title: 'Azure AI Search', detail: ['Dependency span'], icon: 'search', x: 910, y: 405, w: 360, h: 100, step: 3 },
      { id: 'otel', title: 'OpenTelemetry', detail: ['Dashboard or Azure Monitor'], icon: 'pulse', x: 10, y: 405, w: 360, h: 100, step: 4 },
    ],
    edges: [
      { from: 'request', to: 'agent', path: centerline, step: 1, label: 'child', x: 415, y: 61 },
      { from: 'agent', to: 'chat', path: centerline, step: 2, label: 'model', x: 865, y: 61 },
      { from: 'agent', to: 'tool', path: 'M640 125 V215', step: 2, label: 'tools', x: 692, y: 176 },
      { from: 'tool', to: 'embed', path: centerline, step: 3, label: 'embed', x: 865, y: 251 },
      { from: 'embed', to: 'search', path: 'M1090 315 V405', step: 3, label: 'query', x: 1142, y: 366 },
      { from: 'request', to: 'otel', path: 'M190 125 V405', step: 4, label: 'OTLP', x: 234, y: 270, kind: 'telemetry' },
    ],
  },
};

export const diagramKeys = Object.keys(diagrams);

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character));
}

export function renderDiagrams() {
  for (const mount of document.querySelectorAll<HTMLElement>('[data-diagram]')) {
    const key = mount.dataset.diagram ?? '';
    const diagram = diagrams[key];
    if (!diagram) throw new Error(`Unknown architecture diagram: ${key}`);
    const nodesById = new Map(diagram.nodes.map((node) => [node.id, node]));
    const connections = diagram.edges.map((edge) => {
      const source = nodesById.get(edge.from);
      const target = nodesById.get(edge.to);
      if (!source || !target) throw new Error(`Missing endpoint for ${key}: ${edge.from} -> ${edge.to}`);
      return {
        ...edge,
        path: typeof edge.path === 'function' ? edge.path(source, target) : edge.path,
        step: Math.max(edge.step, source.step, target.step),
      };
    });
    const steps = Math.max(...diagram.nodes.map((node) => node.step), ...connections.map((edge) => edge.step));
    const stages = Array.from({ length: steps + 1 }, (_, step) => {
      const edges = connections.filter((edge) => edge.step === step).map((edge) => `
        <g class="graph-edge ${edge.kind ?? ''}" data-from="${edge.from}" data-to="${edge.to}">
          <path class="edge-path" d="${edge.path}" pathLength="1" marker-end="url(#${key}-arrow)" />
          ${edge.label ? `<text class="edge-label" x="${edge.x}" y="${edge.y}">${escape(edge.label)}</text>` : ''}
        </g>`).join('');
      const nodes = diagram.nodes.filter((node) => node.step === step).map((node) => `
        <g class="graph-node ${node.kind ?? ''}" data-node="${node.id}" transform="translate(${node.x} ${node.y})">
          <rect width="${node.w}" height="${node.h}" rx="12" />
          <g transform="translate(18 18)">${icon(node.icon)}</g>
          <text class="node-title" x="54" y="36">${escape(node.title)}</text>
          ${node.detail.map((line, index) => `<text class="node-detail" x="18" y="${70 + index * 28}">${escape(line)}</text>`).join('')}
        </g>`).join('');
      return `<g class="graph-stage${step > 0 ? ' fragment' : ''}" ${step > 0 ? `data-fragment-index="${step - 1}"` : ''} data-stage="${step}">${edges}${nodes}</g>`;
    }).join('');
    mount.innerHTML = `
      <svg class="architecture-svg" data-graph="${key}" viewBox="0 0 ${diagram.width} ${diagram.height}" role="img"
        aria-labelledby="${key}-title ${key}-description" xmlns="http://www.w3.org/2000/svg">
        <title id="${key}-title">${escape(diagram.title)}</title>
        <desc id="${key}-description">${escape(diagram.description)}</desc>
        <defs><marker id="${key}-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L8 5 L1 9" class="arrow-head" /></marker></defs>
        ${stages}
      </svg>
      <ol class="architecture-mobile" aria-label="${escape(diagram.title)}">
        ${diagram.nodes.map((node) => `<li class="${node.kind ?? ''}" data-mobile-node="${node.id}"><span class="stage-icon">${icon(node.icon)}</span><div><strong>${escape(node.title)}</strong><p>${escape(node.detail.join('. '))}</p><small>${diagram.edges.filter((edge) => edge.from === node.id).map((edge) => `To ${escape(diagram.nodes.find((target) => target.id === edge.to)?.title ?? edge.to)}`).join('; ')}</small></div></li>`).join('')}
        ${diagram.returnNote ? `<li class="cycle-return"><span class="stage-icon">${icon('arrowRight')}</span><div><strong>${escape(diagram.returnTitle ?? 'Return path')}</strong><p>${escape(diagram.returnNote)}</p></div></li>` : ''}
      </ol>`;
    mount.dataset.steps = String(steps);
  }
}
