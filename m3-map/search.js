// TurfScope address search helpers: clean up what people type or paste before asking the
// NYS address locator. Plain script: defines window.TurfSearch (npm test loads it too).
(function (root) {
  'use strict';

  // Pasted addresses (Apple Maps, Contacts, texts) carry line breaks, non-breaking spaces and
  // invisible direction marks; they look fine on screen but the locator can't match them.
  function cleanAddress(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')   // invisible marks
      .replace(/[\r\n\t\u00A0\u2028\u2029]+/g, ', ')                     // line breaks and odd spaces → separators
      .replace(/[\u2010-\u2015]/g, '-')                                  // fancy dashes in Queens house numbers
      .replace(/\s*,\s*(,\s*)+/g, ', ')
      .replace(/(?:,\s*|\s+)(united states( of america)?|u\.?s\.?a?\.?)\s*$/i, '') // trailing country (a separate word, so “Columbus” is safe)
      .replace(/\s+/g, ' ')
      .replace(/^[\s,]+|[\s,]+$/g, '');
  }

  // What to try, in order, until the locator finds something:
  //   1. the whole cleaned address (adds ", NY" if no state is given)
  //   2. without the ZIP
  //   3. just house number + street, anywhere in the turf area
  function searchVariants(text) {
    const full = cleanAddress(text);
    if (!full) return [];
    const withState = (s) => (/\bNY\b|\bNew York\b/i.test(s) ? s : `${s}, NY`);
    const noZip = full.replace(/\s*\b\d{5}(-\d{4})?\b\s*$/, '').replace(/[\s,]+$/, '');
    const street = full.split(',')[0].trim();
    const out = [withState(full), withState(noZip), `${street}, NY`];
    return [...new Set(out.filter((s) => s.replace(/, NY$/, '').length >= 4))];
  }

  root.TurfSearch = { cleanAddress, searchVariants };
})(typeof window !== 'undefined' ? window : globalThis);
