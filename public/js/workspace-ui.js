/** UI layout only. No renderer options, datasets, or camera state are changed. */
export function initWorkspaceUI() {
  const panel = document.getElementById('data-panel');
  const toggle = document.getElementById('panel-toggle');
  const close = document.getElementById('panel-close');
  const focus = document.getElementById('focus-map');
  const media = matchMedia('(max-width:760px)');
  let desktopOpen = true, mobileOpen = false, focused = false;
  const panelOpen = () => !focused && (media.matches ? mobileOpen : desktopOpen);
  const sync = () => {
    const open = panelOpen();
    panel.hidden = !open;
    document.body.classList.toggle('panel-collapsed', !open);
    document.body.classList.toggle('map-focus', focused);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起数据设置' : '打开数据设置');
    toggle.title = open ? '收起数据设置' : '打开数据设置';
    focus.setAttribute('aria-pressed', String(focused));
    focus.querySelector('span').textContent = focused ? '退出专注' : '专注地图';
  };
  const setOpen = open => {
    focused = false;
    if (media.matches) mobileOpen = open;
    else desktopOpen = open;
    sync();
  };
  toggle.addEventListener('click', () => {
    const open = !panelOpen();
    setOpen(open);
    if (media.matches && open) {
      panel.scrollIntoView({block:'start', behavior:'instant'});
      close.focus({preventScroll:true});
    }
  });
  close.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  focus.addEventListener('click', () => {
    focused = !focused;
    sync();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && focused && !focus.disabled && !document.querySelector('dialog[open]')) {
      focused = false;
      sync();
      focus.focus();
      event.preventDefault();
    }
  });
  media.addEventListener('change', () => {
    // A desktop-only focus mode must not strand the mobile settings controls.
    if (media.matches) focused = false;
    sync();
  });
  sync();
  return {
    setView(view) {
      document.body.dataset.workspace = view;
      if (view !== 'live') focused = false;
      focus.hidden = view !== 'live';
      document.querySelectorAll('[data-view]').forEach(button => {
        if (button.dataset.view === view) button.setAttribute('aria-current','page');
        else button.removeAttribute('aria-current');
      });
      const neural = document.getElementById('neural-jump');
      if (view === 'neural') neural.setAttribute('aria-current','page');
      else neural.removeAttribute('aria-current');
      sync();
    }
  };
}
