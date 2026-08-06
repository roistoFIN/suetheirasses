import { useEffect } from 'react';

/**
 * Updates `document.title` and the `<meta name="description">` tag on mount — the
 * closest a client-only SPA (no SSR) can get to distinct per-page search-result
 * snippets. `index.html`'s static tags are the homepage's own copy, so every other real
 * route (Rules, Devlog, etc.) calls this to overwrite them once React mounts; `Home.tsx`
 * doesn't need to, since the static defaults already match it. Every route here is a full
 * page load (`<a href>`, not client-side nav — see App.tsx's own doc comment), so there's
 * no stale-title risk from a previous page lingering, and nothing to restore on unmount.
 *
 * Deliberately doesn't touch `og:*`/`twitter:*`/canonical tags — those are read by
 * link-preview scrapers (WhatsApp, Discord, Slack) that fetch raw HTML and don't execute
 * JavaScript, so a client-side update would never actually reach them. Only `document.title`
 * and the description (both read by Googlebot, which does run JS) are worth updating this
 * way; true per-page OG/canonical tags would need real server-side rendering.
 */
export function usePageMeta(title: string, description: string): void {
  useEffect(() => {
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  }, [title, description]);
}
