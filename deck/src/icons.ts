import arrowLeft from '@primer/octicons/build/svg/arrow-left-24.svg?raw';
import arrowRight from '@primer/octicons/build/svg/arrow-right-24.svg?raw';
import beaker from '@primer/octicons/build/svg/beaker-24.svg?raw';
import book from '@primer/octicons/build/svg/book-24.svg?raw';
import broadcast from '@primer/octicons/build/svg/broadcast-24.svg?raw';
import bug from '@primer/octicons/build/svg/bug-24.svg?raw';
import check from '@primer/octicons/build/svg/check-circle-24.svg?raw';
import checklist from '@primer/octicons/build/svg/checklist-24.svg?raw';
import cloud from '@primer/octicons/build/svg/cloud-24.svg?raw';
import code from '@primer/octicons/build/svg/code-24.svg?raw';
import review from '@primer/octicons/build/svg/code-review-24.svg?raw';
import commentDiscussion from '@primer/octicons/build/svg/comment-discussion-24.svg?raw';
import containerSvg from '@primer/octicons/build/svg/container-24.svg?raw';
import cpu from '@primer/octicons/build/svg/cpu-24.svg?raw';
import database from '@primer/octicons/build/svg/database-24.svg?raw';
import agent from '@primer/octicons/build/svg/dependabot-24.svg?raw';
import eye from '@primer/octicons/build/svg/eye-24.svg?raw';
import file from '@primer/octicons/build/svg/file-code-24.svg?raw';
import gear from '@primer/octicons/build/svg/gear-24.svg?raw';
import graph from '@primer/octicons/build/svg/graph-24.svg?raw';
import github from '@primer/octicons/build/svg/mark-github-24.svg?raw';
import key from '@primer/octicons/build/svg/key-24.svg?raw';
import law from '@primer/octicons/build/svg/law-24.svg?raw';
import lightBulb from '@primer/octicons/build/svg/light-bulb-24.svg?raw';
import link from '@primer/octicons/build/svg/link-24.svg?raw';
import lock from '@primer/octicons/build/svg/lock-24.svg?raw';
import menu from '@primer/octicons/build/svg/three-bars-24.svg?raw';
import moon from '@primer/octicons/build/svg/moon-24.svg?raw';
import packageIcon from '@primer/octicons/build/svg/package-24.svg?raw';
import person from '@primer/octicons/build/svg/person-24.svg?raw';
import plug from '@primer/octicons/build/svg/plug-24.svg?raw';
import pr from '@primer/octicons/build/svg/git-pull-request-24.svg?raw';
import pulse from '@primer/octicons/build/svg/pulse-24.svg?raw';
import repo from '@primer/octicons/build/svg/repo-24.svg?raw';
import rocket from '@primer/octicons/build/svg/rocket-24.svg?raw';
import screen from '@primer/octicons/build/svg/device-desktop-24.svg?raw';
import search from '@primer/octicons/build/svg/search-24.svg?raw';
import server from '@primer/octicons/build/svg/server-24.svg?raw';
import shield from '@primer/octicons/build/svg/shield-lock-24.svg?raw';
import stack from '@primer/octicons/build/svg/stack-24.svg?raw';
import stopwatch from '@primer/octicons/build/svg/stopwatch-24.svg?raw';
import sun from '@primer/octicons/build/svg/sun-24.svg?raw';
import sync from '@primer/octicons/build/svg/sync-24.svg?raw';
import table from '@primer/octicons/build/svg/table-24.svg?raw';
import terminal from '@primer/octicons/build/svg/terminal-24.svg?raw';
import tools from '@primer/octicons/build/svg/tools-24.svg?raw';
import versions from '@primer/octicons/build/svg/versions-24.svg?raw';
import workflow from '@primer/octicons/build/svg/workflow-24.svg?raw';
import close from '@primer/octicons/build/svg/x-24.svg?raw';
import { faBluesky, faLinkedinIn, faXTwitter } from '@fortawesome/free-brands-svg-icons';

function brandSvg(definition: typeof faBluesky): string {
  const [width, height, , , paths] = definition.icon;
  const pathData = typeof paths === 'string' ? [paths] : paths;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${pathData.map((path) => `<path d="${path}" />`).join('')}</svg>`;
}

const icons = {
  arrowLeft,
  arrowRight,
  beaker,
  book,
  broadcast,
  bug,
  chat: commentDiscussion,
  check,
  checklist,
  cloud,
  code,
  container: containerSvg,
  cpu,
  database,
  agent,
  eye,
  file,
  gear,
  github,
  graph,
  key,
  law,
  lightBulb,
  link,
  lock,
  menu,
  moon,
  package: packageIcon,
  person,
  plug,
  pr,
  pulse,
  repo,
  review,
  rocket,
  screen,
  search,
  server,
  shield,
  stack,
  stopwatch,
  sun,
  sync,
  table,
  terminal,
  tools,
  versions,
  workflow,
  close,
  socialX: brandSvg(faXTwitter),
  socialBluesky: brandSvg(faBluesky),
  socialLinkedIn: brandSvg(faLinkedinIn),
};

export type IconName = keyof typeof icons;

export function icon(name: IconName): string {
  return icons[name].replace('<svg ', `<svg aria-hidden="true" focusable="false" class="octicon icon-${name}" `);
}

export function renderIcons(scope: ParentNode = document) {
  for (const slot of scope.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = slot.dataset.icon;
    if (!name || !Object.hasOwn(icons, name)) throw new Error(`Unknown presentation icon: ${name}`);
    slot.innerHTML = icon(name as IconName);
    slot.setAttribute('aria-hidden', 'true');
  }
}
