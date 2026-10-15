// Parsing and syntax detection must never compete with typing or scrolling.
// Only library-generated HTML leaves this worker; the UI still sanitizes it.
let parserReady = false;
let highlighterReady = false;
self.onmessage = ({ data: { id, type, text, language } }) => {
  try {
    let html;
    if (type === 'markdown') {
      if (!parserReady) {
        importScripts('/chat/vendor/marked.umd.js?v=19');
        self.marked.setOptions({ gfm: true, breaks: true });
        parserReady = true;
      }
      html = self.marked.parse(text);
    } else {
      if (!highlighterReady) {
        importScripts('/chat/vendor/highlight.min.js?v=19');
        highlighterReady = true;
      }
      html = language && self.hljs.getLanguage(language)
        ? self.hljs.highlight(text, { language, ignoreIllegals: true }).value
        : self.hljs.highlightAuto(text).value;
    }
    self.postMessage({ id, html });
  } catch {
    self.postMessage({ id, html: null });
  }
};
