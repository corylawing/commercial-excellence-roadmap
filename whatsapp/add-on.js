/* The install page's one button: copy chrome://extensions (a web page cannot open it with a link). */
document.getElementById('copy-ext').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
        await navigator.clipboard.writeText('chrome://extensions');
        btn.textContent = 'Copied';
    } catch {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('ext-url'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Press ⌘C';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
});
