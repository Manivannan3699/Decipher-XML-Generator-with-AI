/* app.js
   Decipher XML Generator — replacement full app logic.
   Features:
   - Paste or upload DOCX to extract raw text (document.xml via JSZip)
   - AI-assisted extraction (uses user's API key; calls from browser)
   - Local heuristic fallback parsing
   - Multi-question editor with add/edit/delete
   - XML builder supporting radio, radio-atm1d, checkbox, select, number, text, textarea, rating, pipe
   - Auto-detect "Other" rows and set open="1"
   - Tables from DOCX treated as grids when possible (best-effort)
*/

(function () {
  // Utilities
  function $ (sel, root = document) { return root.querySelector(sel); }
  function $$ (sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function qId () { return 'q' + (Date.now().toString(36) + Math.random().toString(36).slice(2,8)); }
  function escapeXml (s) {
    if (!s && s !== 0) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // DOM refs
  const pasteArea = $('#pasteArea');
  const docxUpload = $('#docxUpload');
  const apiKeyInput = $('#apiKey');
  const aiBtn = $('#aiBtn');
  const heuristicBtn = $('#heuristicBtn');
  const questionsList = $('#questionsList');
  const addQuestionBtn = $('#addQuestionBtn');
  const generateAllBtn = $('#generateAllBtn');
  const downloadAllBtn = $('#downloadAllBtn');
  const editorSection = $('#editorSection');
  const xmlOut = $('#xmlOut');
  const downloadXmlBtn = $('#downloadXmlBtn');
  const outFilename = $('#outFilename');

  // Question types
  const QUESTION_TYPES = [
    'radio',
    'radio-atm1d',
    'checkbox',
    'select',
    'number',
    'text',
    'textarea',
    'rating',
    'pipe'
  ];

  // State
  const state = {
    questions: []
  };

  // Create a blank question model
  function createQuestionModel (overrides = {}) {
    return Object.assign({
      id: qId(),
      label: '',           // e.g. S3
      secondaryLabel: '',  // optional repeated label found
      title: '',           // HTML/escaped allowed
      type: 'radio',
      rows: [],            // array of strings
      cols: [],            // optional columns for grids
      comment: ''
    }, overrides);
  }

  // Render the list of detected/added questions
  function renderQuestionsList () {
    questionsList.innerHTML = '';
    if (state.questions.length === 0) {
      questionsList.innerHTML = '<div style="color:#666;padding:10px;border-radius:6px;">No questions yet — paste/upload and extract or add one.</div>';
      return;
    }
    state.questions.forEach((q, idx) => {
      const item = document.createElement('div');
      item.className = 'q-item';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const labelDiv = document.createElement('div');
      labelDiv.className = 'q-label';
      labelDiv.textContent = q.label || '(no label)';
      meta.appendChild(labelDiv);

      const titleDiv = document.createElement('div');
      titleDiv.style.marginLeft = '8px';
      titleDiv.style.flex = '1';
      titleDiv.textContent = (q.title || '').replace(/<[^>]+>/g, '').slice(0, 110);
      meta.appendChild(titleDiv);

      item.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'q-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn secondary';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => openEditor(q);

      const upBtn = document.createElement('button');
      upBtn.className = 'btn secondary';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.onclick = () => {
        if (idx <= 0) return;
        const tmp = state.questions[idx - 1];
        state.questions[idx - 1] = state.questions[idx];
        state.questions[idx] = tmp;
        renderQuestionsList();
      };

      const downBtn = document.createElement('button');
      downBtn.className = 'btn secondary';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.onclick = () => {
        if (idx >= state.questions.length - 1) return;
        const tmp = state.questions[idx + 1];
        state.questions[idx + 1] = state.questions[idx];
        state.questions[idx] = tmp;
        renderQuestionsList();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn secondary';
      delBtn.textContent = 'Delete';
      delBtn.onclick = () => {
        if (!confirm('Delete question?')) return;
        state.questions.splice(idx, 1);
        renderQuestionsList();
        closeEditor();
      };

      actions.appendChild(editBtn);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(delBtn);

      item.appendChild(actions);
      questionsList.appendChild(item);
    });
  }

  // Open editor card for a question (fills editorSection)
  function openEditor (q) {
    editorSection.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card';

    const hdr = document.createElement('div');
    hdr.innerHTML = '<strong>Edit question</strong>';
    card.appendChild(hdr);

    const fields = document.createElement('div');
    fields.className = 'fields';

    // Left column: label, secondary, title, comment
    const left = document.createElement('div');
    left.innerHTML = `
      <label>Label</label>
      <input data-field="label" type="text" value="${escapeHtmlAttr(q.label)}" />
      <label>Secondary label (optional)</label>
      <input data-field="secondary" type="text" value="${escapeHtmlAttr(q.secondaryLabel)}" />
      <label>Title (HTML allowed)</label>
      <textarea data-field="title">${escapeHtmlText(q.title)}</textarea>
      <label>Comment (optional)</label>
      <input data-field="comment" type="text" value="${escapeHtmlAttr(q.comment)}" />
    `;

    // Right column: type, rows, cols
    const right = document.createElement('div');
    const typeOptions = QUESTION_TYPES.map(t => `<option value="${t}" ${t === q.type ? 'selected' : ''}>${t}</option>`).join('');
    right.innerHTML = `
      <label>Type</label>
      <select data-field="type">${typeOptions}</select>
      <label>Rows (one per line)</label>
      <textarea data-field="rows">${(q.rows || []).join('\n')}</textarea>
      <label>Columns (one per line)</label>
      <textarea data-field="cols">${(q.cols || []).join('\n')}</textarea>
    `;

    fields.appendChild(left);
    fields.appendChild(right);
    card.appendChild(fields);

    const controls = document.createElement('div');
    controls.style.marginTop = '12px';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => {
      const inputs = card.querySelectorAll('[data-field]');
      inputs.forEach(inp => {
        const field = inp.getAttribute('data-field');
        if (field === 'label') q.label = inp.value.trim();
        else if (field === 'secondary') q.secondaryLabel = inp.value.trim();
        else if (field === 'title') q.title = inp.value;
        else if (field === 'comment') q.comment = inp.value.trim();
        else if (field === 'type') q.type = inp.value;
        else if (field === 'rows') q.rows = inp.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        else if (field === 'cols') q.cols = inp.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      });
      // post-process: auto set open rows if rows contain Other
      q.rows = q.rows.map(r => r);
      renderQuestionsList();
      closeEditor();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeEditor;

    controls.appendChild(saveBtn);
    controls.appendChild(cancelBtn);
    card.appendChild(controls);

    editorSection.appendChild(card);
    // scroll into view
    card.scrollIntoView({ behavior: 'smooth' });

    // helpers to escape HTML in inputs
    function escapeHtmlAttr (s) { return (s || '').replace(/"/g, '&quot;'); }
    function escapeHtmlText (s) { return (s || ''); }
  }

  function closeEditor () {
    editorSection.innerHTML = '';
  }

  // Add blank question
  addQuestionBtn.addEventListener('click', () => {
    const q = createQuestionModel();
    state.questions.push(q);
    renderQuestionsList();
    openEditor(q);
  });

  // XML builders (with open="1" detection for Other)
  function rowXml (text, i) {
    // auto detect "Other" rows and include open="1" attribute
    const lower = (text || '').toLowerCase();
    const isOther = /\bother\b/.test(lower) || /\bspecify\b/.test(lower);
    if (isOther) {
      return `  <row label="r${i + 1}" open="1">${escapeXml(text)}</row>\n`;
    } else {
      return `  <row label="r${i + 1}">${escapeXml(text)}</row>\n`;
    }
  }

  function colXml (text, i) {
    return `  <col label="c${i + 1}">${escapeXml(text)}</col>\n`;
  }

  function buildRadioXml (q, atm1d = false) {
    let attrs = `  label="${escapeXml(q.label || '')}"`;
    let head = `<radio\n${attrs}>\n`;
    if (atm1d) {
      head = `<radio\n  label="${escapeXml(q.label || '')}"\n  atm1d:showInput="0"\n  uses="atm1d.10">\n`;
    }
    let xml = head;
    xml += `  <title>${q.title ? q.title : ''}</title>\n`;
    if (q.rows && q.rows.length) {
      q.rows.forEach((r, i) => { xml += rowXml(r, i); });
    }
    if (q.cols && q.cols.length) {
      q.cols.forEach((c, i) => { xml += colXml(c, i); });
    }
    xml += `</radio>\n<suspend/>\n`;
    return xml;
  }

  function buildCheckboxXml (q) {
    let xml = `<checkbox\n  label="${escapeXml(q.label || '')}"\n  atleast="1">\n`;
    xml += `  <title>${q.title ? q.title : ''}</title>\n`;
    if (q.rows && q.rows.length) q.rows.forEach((r, i) => { xml += rowXml(r, i); });
    if (q.cols && q.cols.length) q.cols.forEach((c, i) => { xml += colXml(c, i); });
    xml += `</checkbox>\n<suspend/>\n`;
    return xml;
  }

  function buildSelectXml (q) {
    let xml = `<select\n  label="${escapeXml(q.label || '')}" optional="0">\n`;
    xml += `  <title>${q.title ? q.title : ''}</title>\n`;
    if (q.rows && q.rows.length) q.rows.forEach((r, i) => {
      xml += `  <choice label="ch${i + 1}">${escapeXml(r)}</choice>\n`;
    });
    xml += `</select>\n<suspend/>\n`;
    return xml;
  }

  function buildNumberXml (q) {
    // basic number builder; extend autosum logic here if needed
    let xml = `<number\n  label="${escapeXml(q.label || '')}"\n  size="3"\n  optional="0">\n`;
    xml += `  <title>${q.title ? q.title : ''}</title>\n`;
    xml += `</number>\n<suspend/>\n`;
    return xml;
  }

  function buildTextXml (q) {
    return `<text\n  label="${escapeXml(q.label || '')}"\n  size="40"\n  optional="0">\n  <title>${q.title ? q.title : ''}</title>\n</text>\n<suspend/>\n`;
  }

  function buildTextareaXml (q) {
    return `<textarea\n  label="${escapeXml(q.label || '')}"\n  optional="0">\n  <title>${q.title ? q.title : ''}</title>\n  <comment>Please be as specific as possible</comment>\n</textarea>\n<suspend/>\n`;
  }

  function buildRatingXml (q) {
    let xml = `<radio\n  label="${escapeXml(q.label || '')}"\n  type="rating">\n  <title>${q.title ? q.title : ''}</title>\n`;
    if (q.rows && q.rows.length) q.rows.forEach((r, i) => { xml += rowXml(r, i); });
    xml += `</radio>\n<suspend/>\n`;
    return xml;
  }

  function buildPipeXml (q) {
    return `<pipe\n  label=""\n  capture="">\n  ${escapeXml(q.title || '')}\n</pipe>\n`;
  }

  // Generate all XML from state.questions
  generateAllBtn.addEventListener('click', () => {
    if (state.questions.length === 0) return alert('No questions to generate. Add or extract some first.');
    let out = `<survey name="Survey" alt="" autosave="0">\n\n`;
    state.questions.forEach(q => {
      // ensure label present
      if (!q.label) q.label = 'Q' + (Math.floor(Math.random() * 9000) + 1000);
      switch (q.type) {
        case 'radio-atm1d':
          out += buildRadioXml(q, true);
          break;
        case 'radio':
          out += buildRadioXml(q, false);
          break;
        case 'checkbox':
          out += buildCheckboxXml(q);
          break;
        case 'select':
          out += buildSelectXml(q);
          break;
        case 'number':
          out += buildNumberXml(q);
          break;
        case 'text':
          out += buildTextXml(q);
          break;
        case 'textarea':
          out += buildTextareaXml(q);
          break;
        case 'rating':
          out += buildRatingXml(q);
          break;
        case 'pipe':
          out += buildPipeXml(q);
          break;
        default:
          out += buildRadioXml(q, false);
          break;
      }
      out += '\n';
    });
    out += `</survey>`;
    xmlOut.textContent = out;
    downloadXmlBtn.disabled = false;
    downloadAllBtn.disabled = false;
  });

  // Download XML
  downloadXmlBtn.addEventListener('click', () => {
    if (!xmlOut.textContent || xmlOut.textContent.includes('<!--')) return alert('Generate XML first.');
    const filename = (outFilename.value || 'survey.xml').trim();
    const a = document.createElement('a');
    a.href = 'data:text/xml;charset=utf-8,' + encodeURIComponent(xmlOut.textContent);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // downloadAll button same as downloadXml
  downloadAllBtn.addEventListener('click', () => {
    downloadXmlBtn.click();
  });

  // Heuristic local parsing (for pasted text)
  // Splits pasted text into candidate blocks and parses simple label/title/options
  function localSplitBlocks (text) {
    // split on double newline (paragraph break) or on label-like lines
    const lines = text.replace(/\r/g, '').split('\n');
    const blocks = [];
    let cur = [];
    const labelLineRegex = /^[A-Za-z]{1,5}[0-9]{0,4}[A-Za-z]?\.?(\s|$)/; // e.g. S1. or A10
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) {
        if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
        continue;
      }
      if (labelLineRegex.test(l.split(' ')[0]) && cur.length) {
        // new block starts
        blocks.push(cur.join('\n'));
        cur = [l];
      } else {
        cur.push(l);
      }
    }
    if (cur.length) blocks.push(cur.join('\n'));
    return blocks;
  }

  function heuristicParseBlock (block) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    let label = '';
    let secondary = '';
    let title = '';
    const rows = [];
    const cols = [];
    // detect label on first line: "S1. Title..." or "S1." followed by next line
    const first = lines[0] || '';
    const firstMatch = first.match(/^([A-Za-z]{1,5}[0-9]{0,4}[A-Za-z]?)\.?\s*(.*)$/);
    let start = 0;
    if (firstMatch) {
      label = firstMatch[1];
      if (firstMatch[2]) title = firstMatch[2];
      start = 1;
    }
    // if next line is same label without dot (secondary), capture it
    if (start < lines.length && lines[start] && lines[start] === label) {
      secondary = lines[start];
      start++;
    }
    // collect potential metadata lines (PN:, SHOW ALL etc.) - skip these
    while (start < lines.length && (/^[A-Z\s:]+$/.test(lines[start]) || lines[start].endsWith(':'))) { start++; }
    // next non-empty line is title if not already set
    if (!title && start < lines.length) {
      title = lines[start];
      start++;
    }
    // remaining lines: treat as options if they look like bullets/numbers or symbols
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      const optMatch = l.match(/^[\-\u2022\*]?\s*(?:[A-Za-z0-9]{1,3}[\.\)]\s*)?(.+)$/);
      if (optMatch) rows.push(optMatch[1].trim());
      else {
        // if line contains tab or pipe, maybe columns or continuation
        if (l.includes('\t') || l.includes('|')) {
          // skip - simple heuristics for now
          const parts = l.split(/\t|\|/).map(s => s.trim()).filter(Boolean);
          if (parts.length > 1) {
            // treat as row label and first column(s)
            rows.push(parts.slice(1).join(' | '));
            if (cols.length === 0 && parts.length > 1) {
              // assume first row had header columns: naive
              // not doing deep table parsing here
            }
          } else {
            rows.push(l);
          }
        } else {
          rows.push(l);
        }
      }
    }

    // guess type
    let type = 'radio';
    if (/select all|multiple/i.test(block)) type = 'checkbox';
    else if (/select one|choose one|single/i.test(block)) type = 'radio';
    else if (/%|percentage/i.test(block)) type = 'number';

    return createQuestionModel({
      label, secondaryLabel: secondary, title, type, rows, cols
    });
  }

  heuristicBtn.addEventListener('click', () => {
    const text = pasteArea.value.trim();
    if (!text) return alert('Paste or upload document first.');
    const blocks = localSplitBlocks(text);
    if (!blocks || blocks.length === 0) return alert('No blocks detected by heuristic.');
    let added = 0;
    for (const blk of blocks) {
      try {
        const q = heuristicParseBlock(blk);
        state.questions.push(q);
        added++;
      } catch (err) {
        console.warn('Heuristic parse error', err);
      }
    }
    renderQuestionsList();
    alert('Local extraction added ' + added + ' question(s). Edit to refine.');
  });

  // AI extraction - uses user's API key; fallback to local heuristic if no key or failure
  async function aiExtractBlock (block, apiKey) {
    // OpenAI-style Chat Completions JSON-only prompt
    const system = "You are a JSON-only assistant that reads a survey question block and outputs valid JSON with keys: label (string), secondaryLabel (string or empty), title (string), type (one of radio, radio-atm1d, checkbox, select, number, text, textarea, rating, pipe), rows (array of strings), cols (array of strings). Return strictly and only JSON.";
    const userPrompt = `Parse this survey question block and return the JSON described:\n\n${block}\n\nMake rows an array of option strings. Make cols an array of column headers if the block is a grid. If there is an "Other" option include it as a row and mark it normally (the builder will set open=\"1\").`;
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error('AI API error: ' + res.status + ' ' + res.statusText + ' — ' + txt);
    }

    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AI returned no content');

    // Try to extract JSON from the assistant content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI output does not contain JSON');
    try {
      const obj = JSON.parse(jsonMatch[0]);
      // Normalize fields
      obj.label = obj.label || '';
      obj.secondaryLabel = obj.secondaryLabel || '';
      obj.title = obj.title || '';
      obj.type = obj.type || 'radio';
      obj.rows = Array.isArray(obj.rows) ? obj.rows : (obj.rows ? [obj.rows] : []);
      obj.cols = Array.isArray(obj.cols) ? obj.cols : (obj.cols ? [obj.cols] : []);
      return obj;
    } catch (err) {
      throw new Error('Failed to parse JSON from AI output: ' + err.message);
    }
  }

  // AI Extract button behavior: splits pasteArea into blocks and runs AI (or heuristic if no key)
  aiBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const text = pasteArea.value.trim();
    if (!text) return alert('Paste or upload document first.');

    // naive split: double-newline blocks or label boundaries
    const blocks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (blocks.length === 0) return alert('No blocks detected');

    aiBtn.disabled = true;
    aiBtn.textContent = 'Extracting...';

    let added = 0;
    try {
      for (const blk of blocks) {
        try {
          let obj = null;
          if (apiKey) {
            try {
              obj = await aiExtractBlock(blk, apiKey);
            } catch (err) {
              console.warn('AI failed for block — falling back to heuristic', err);
              obj = null;
            }
          }
          if (!obj) {
            // fallback to heuristic
            const q = heuristicParseBlock(blk);
            state.questions.push(q);
            added++;
          } else {
            const q = createQuestionModel({
              label: obj.label,
              secondaryLabel: obj.secondaryLabel,
              title: obj.title,
              type: obj.type,
              rows: obj.rows || [],
              cols: obj.cols || []
            });
            state.questions.push(q);
            added++;
          }
          renderQuestionsList();
        } catch (err) {
          console.warn('Block parse failed', err);
        }
      }
      alert('Extraction finished. Added ' + added + ' question(s). Review and edit before generating XML.');
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = 'AI Extract';
    }
  });

  // DOCX upload: read docx ZIP & extract word/document.xml, do best-effort conversion to text + tables
  docxUpload.addEventListener('change', function (e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function (evt) {
      const ab = evt.target.result;
      if (typeof JSZip === 'undefined') return alert('JSZip not loaded');
      JSZip.loadAsync(ab).then(zip => {
        const file = zip.file('word/document.xml');
        if (!file) return alert('This .docx does not contain word/document.xml');
        file.async('string').then(xml => {
          // very simple xml -> text extraction that preserves paragraphs and table cells
          // parse XML DOM
          try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'application/xml');
            const body = doc.getElementsByTagName('w:body')[0] || doc.getElementsByTagName('body')[0];
            if (!body) { pasteArea.value = xml; return alert('Could not parse document.xml, pasted raw xml.'); }
            const blocks = [];
            // iterate child nodes of body
            for (let i = 0; i < body.childNodes.length; i++) {
              const node = body.childNodes[i];
              if (node.nodeType !== 1) continue;
              const tag = node.nodeName || node.localName || '';
              if (tag.indexOf('p') !== -1 || tag === 'w:p') {
                // paragraph: collect w:t runs
                const texts = node.getElementsByTagName('w:t');
                let t = '';
                for (let j = 0; j < texts.length; j++) t += texts[j].textContent || '';
                if (t.trim()) blocks.push(t.trim());
              } else if (tag.indexOf('tbl') !== -1 || tag === 'w:tbl') {
                // table: collect rows & cells as pipe-separated lines
                const tr = node.getElementsByTagName('w:tr');
                for (let r = 0; r < tr.length; r++) {
                  const row = tr[r];
                  const tc = row.getElementsByTagName('w:tc');
                  const cells = [];
                  for (let c = 0; c < tc.length; c++) {
                    const paras = tc[c].getElementsByTagName('w:t');
                    let cellText = '';
                    for (let p = 0; p < paras.length; p++) cellText += paras[p].textContent || '';
                    cells.push(cellText.trim());
                  }
                  // join with pipe; keep as one block line so block splitting works
                  blocks.push(cells.join(' | '));
                }
              }
            }
            // join blocks with double newline to mimic paragraphs
            pasteArea.value = blocks.join('\n\n');
            alert('DOCX extracted to paste area. Use AI Extract or Local Extract to parse blocks.');
          } catch (err) {
            // fallback: strip tags
            const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            pasteArea.value = text;
            alert('DOCX parsing had issues — raw text inserted. Use Local Extract.');
          }
        }).catch(err => alert('Error reading document.xml: ' + err));
      }).catch(err => alert('Error reading .docx ZIP: ' + err));
    };
    reader.readAsArrayBuffer(f);
  });

  // Initial render
  renderQuestionsList();

  // Helper escapes used in input attributes
  function escapeHtmlAttr (s) { return (s || '').replace(/"/g, '&quot;'); }

})();
