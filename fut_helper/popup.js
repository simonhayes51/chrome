(async function(){
  const elToggle = document.getElementById('toggle');
  const elCard = document.getElementById('card');
  const get = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
  const set = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

  async function refresh(){
    let { futhubEnabled } = await get({ futhubEnabled: true });
    if (futhubEnabled) elCard.classList.add('on'); else elCard.classList.remove('on');
  }
  elToggle.addEventListener('click', async () => {
    let { futhubEnabled } = await get({ futhubEnabled: true });
    await set({ futhubEnabled: !futhubEnabled });
    await refresh();
  });
  await refresh();
})();