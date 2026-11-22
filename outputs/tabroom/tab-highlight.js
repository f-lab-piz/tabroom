function sameSelection(left, right) {
  return left.size === right.size && [...left].every(id=>right.has(id));
}

// Chrome takes tab-strip indices. Keep IDs in our state and resolve indices just before calling it.
export function createTabHighlight(browser, windowId) {
  let desired;
  let revision = 0;
  let applied;
  let pending;

  async function update(request, version) {
    const tabs = await browser.tabs.query({windowId});
    const active = tabs.find(tab=>tab.active);
    const selected = new Set(tabs.filter(tab=>tab.highlighted).map(tab=>tab.id));
    if (applied && (active?.id !== applied.anchor || !sameSelection(selected,applied.ids))) applied = null;
    const anchor = active?.id === request?.anchor ? active : null;
    const target = anchor && tabs.find(tab=>tab.id === request.target);
    const group = target?.groupId >= 0 ? await browser.tabGroups.get(target.groupId).catch(()=>null) : null;
    if (version !== revision) return;

    const canHighlight = target && target.id !== anchor.id &&
      !(anchor.splitViewId >= 0 || target.splitViewId >= 0) &&
      (target.groupId < 0 || group && !group.collapsed);
    if (!canHighlight) {
      if (!applied || !active) return;
      const original = applied.original;
      await browser.tabs.highlight({windowId,tabs:[active.index,...tabs.filter(tab=>tab.id !== active.id && original.has(tab.id)).map(tab=>tab.index)]});
      applied = null;
      return;
    }

    const original = applied?.original ?? selected;
    const ids = new Set([anchor.id,...original,target.id]);
    if (sameSelection(selected,ids)) return;
    const next = await browser.tabs.highlight({
      windowId,tabs:[anchor.index,...tabs.filter(tab=>tab.id !== anchor.id && ids.has(tab.id)).map(tab=>tab.index)],
    });
    const windowTabs = next?.tabs;
    if (windowTabs && !sameSelection(new Set(windowTabs.filter(tab=>tab.highlighted).map(tab=>tab.id)),ids)) {
      // The tab strip changed between querying its indices and applying them.
      const liveAnchor = windowTabs.find(tab=>tab.id === anchor.id);
      if (liveAnchor) {
        await browser.tabs.highlight({windowId,tabs:[liveAnchor.index,...windowTabs
          .filter(tab=>tab.id !== anchor.id && original.has(tab.id)).map(tab=>tab.index)]});
      }
      applied = null;
      return;
    }
    applied = {anchor:anchor.id,ids,original};
  }

  async function drain() {
    let seen;
    do {
      seen = revision;
      await update(desired,seen).catch(()=>{});
    } while (seen !== revision);
  }

  return {
    select(anchor,target) {
      desired = Number.isInteger(anchor) && Number.isInteger(target) ? {anchor,target} : null;
      ++revision;
      pending ||= drain().finally(()=>{pending=null;});
      return pending;
    },
  };
}
