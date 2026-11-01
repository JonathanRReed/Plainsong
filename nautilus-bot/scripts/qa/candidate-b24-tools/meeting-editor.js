(async()=>{
  // The QA driver substitutes this placeholder before the snippet runs.
  // eslint-disable-next-line no-undef
  const marker=MARKER;
  for(let i=0;i<100;i++){
    const group=document.querySelector('[role="group"][aria-label="Meeting notes"]');
    let editor=group?.querySelector('textarea:not([readonly]):not([disabled])')
      ||document.querySelector('textarea[aria-label="Goals notes"]:not([readonly]):not([disabled])');
    if(!editor){
      const edit=document.querySelector('button[aria-label="Edit Summary"]');
      if(edit&&!edit.disabled)edit.click();
      editor=document.querySelector('textarea[aria-label="Summary"]:not([readonly]):not([disabled])');
    }
    if(editor){
      editor.focus();
      const value=editor.value+'\n'+marker;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,value);
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      if(!editor.value.includes(marker))throw Error('React did not retain the edit');
      return {label:editor.getAttribute('aria-label'),value:editor.value,marker};
    }
    if(group){const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Add section');if(b&&!b.disabled)b.click();}
    await new Promise(r=>setTimeout(r,200));
  }
  throw Error('No editable meeting-notes field or Summary editor');
})()
