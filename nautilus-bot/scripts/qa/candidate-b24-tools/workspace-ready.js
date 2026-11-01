Boolean(!document.querySelector('[role="dialog"], [role="alertdialog"]') &&
  document.querySelector('.app-shell:not([inert]) button[aria-current="page"]') &&
  window.__plainsongCanSuspend?.() === true)
