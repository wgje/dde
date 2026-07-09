export function buildFlowDragGhostContent(
  container: HTMLElement,
  title: string,
  count: number,
  suffix?: string,
): void {
  container.textContent = '';

  const icon = document.createElement('span');
  icon.className = 'opacity-60';
  icon.textContent = '⏸';
  container.appendChild(icon);

  container.appendChild(document.createTextNode(` ${title}`));

  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'bg-indigo-400/50 px-1.5 py-0.5 rounded-full text-[10px]';
    badge.textContent = `+${count - 1}`;
    container.appendChild(document.createTextNode(' '));
    container.appendChild(badge);
  }

  if (suffix) {
    const hint = document.createElement('span');
    hint.className = 'ml-1 text-indigo-200 text-[10px]';
    hint.textContent = suffix;
    container.appendChild(hint);
  }
}
