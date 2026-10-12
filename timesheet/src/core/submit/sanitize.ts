/// <reference lib="dom" />

/**
 * Runs inside the page through page.evaluate, so it must stay self-contained (no imports, no
 * outer variables). Returns a copy of the DOM with what selectors are built from (structure,
 * ids, names, classes, data-*, inline style attributes, links, labels, text, current form values)
 * and without scripts, <style> sheets, comments, hidden-field values (CSRF tokens), passwords, secret-looking data-* attributes,
 * URL parameters or fragments, or e-mail addresses.
 */
export function sanitizeDocument(): string {
  const KEEP = new Set(['id', 'name', 'class', 'type', 'role', 'for', 'title', 'href', 'action', 'method', 'colspan', 'rowspan', 'disabled', 'readonly', 'checked', 'selected', 'multiple', 'aria-label', 'placeholder', 'value', 'onclick', 'onchange',
    // Inline styles carry meaning on Worktime (Sunday cells and error banners are both background:#faa); values are clipped and e-mail-redacted.
    'style']);
  const DROP = 'script,style,link,meta,noscript,iframe,svg,canvas,template,img,video,audio,object,embed';
  // Keep in sync with SECRET_PARAM in inspect.ts. Over-matching (e.g. "assigned" has "sig") only hides more.
  const SECRET = /token|csrf|nonce|secret|passw|session|auth|key|sig|ticket|jwt|otp|saml|code/i;
  const URLS = new Set(['href', 'action', 'src', 'onclick', 'formaction']);
  const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const isSecretField = (el: Element) =>
    (el.localName === 'input' && ['hidden', 'password'].includes((el.getAttribute('type') ?? '').toLowerCase())) || SECRET.test(el.getAttribute('name') ?? '') || SECRET.test(el.id);
  /** Query values under secret-looking names become "…", and so does a fragment carrying values (#access_token=…). */
  const redactUrls = (v: string) =>
    v
      .replace(/(&amp;|[?&;])([^=&#\s'"]*)=([^&#\s'"]*)/g, (m, sep: string, name: string) => (SECRET.test(name) ? `${sep}${name}=…` : m))
      .replace(/#[^\s'"]*/g, (m) => (m.includes('=') ? '#…' : m));

  const root = document.documentElement.cloneNode(true) as HTMLElement;

  // Current values live in properties, not attributes: copy them from the live fields (same order in the clone).
  const live = [...document.querySelectorAll('input, textarea, select')];
  const copies = [...root.querySelectorAll('input, textarea, select')];
  live.forEach((field, i) => {
    const copy = copies[i];
    if (!copy) return;
    if (field instanceof HTMLSelectElement) {
      [...field.options].forEach((o, j) => {
        const c = copy.querySelectorAll('option')[j];
        if (!c) return;
        if (o.selected) c.setAttribute('selected', '');
        else c.removeAttribute('selected');
      });
      return;
    }
    const input = field as HTMLInputElement | HTMLTextAreaElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden' || type === 'password' || SECRET.test(input.getAttribute('name') ?? '') || SECRET.test(input.id)) {
      copy.removeAttribute('value');
      if (input instanceof HTMLTextAreaElement) copy.textContent = '';
    } else if (type === 'checkbox' || type === 'radio') {
      if ((input as HTMLInputElement).checked) copy.setAttribute('checked', '');
      else copy.removeAttribute('checked');
    } else if (input instanceof HTMLTextAreaElement) {
      copy.textContent = clip(input.value, 200);
    } else {
      copy.setAttribute('value', clip(input.value, 200));
    }
  });

  root.querySelectorAll(DROP).forEach((el) => el.remove());
  // Again on the copy itself, in case live and copied fields ever stop lining up.
  root.querySelectorAll('input, textarea').forEach((el) => {
    if (!isSecretField(el)) return;
    el.removeAttribute('value');
    if (el.localName === 'textarea') el.textContent = '';
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE) comments.push(node);
    else if (node.nodeType === Node.TEXT_NODE) node.textContent = clip((node.textContent ?? '').replace(EMAIL, '<email>'), 300);
    else {
      const el = node as Element;
      for (const attr of [...el.attributes]) {
        const data = attr.name.startsWith('data-');
        if ((!KEEP.has(attr.name) && !data) || (data && SECRET.test(attr.name))) {
          el.removeAttribute(attr.name);
          continue;
        }
        const value = URLS.has(attr.name) || data ? redactUrls(attr.value) : attr.value;
        el.setAttribute(attr.name, clip(value.replace(EMAIL, '<email>'), attr.name.startsWith('on') ? 120 : 200));
      }
    }
  }
  comments.forEach((c) => c.parentNode?.removeChild(c));

  return `<!doctype html>\n${root.outerHTML}`;
}
