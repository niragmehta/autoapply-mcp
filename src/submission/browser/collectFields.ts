/** Runs in the page: tags every form control and returns its descriptor. */
export const COLLECT_FIELDS = `(() => {
  // Workday renders a dropdown as a button, not an input, so a query for form
  // controls alone cannot see it. Those buttons are required fields, and the
  // page will not save without them, so they are collected too. The attribute
  // is specific enough that no other board's controls are pulled in.
  const controls = Array.from(
    document.querySelectorAll(
      'input, textarea, select, button[aria-haspopup="listbox"], [data-automation-id="dateInputWrapper"]',
    ),
  );
  // Some boards plant a decoy input to catch bots that fill every field. Workday
  // ships one on its account pages: 1px tall, name="website", labelled "This
  // input is for robots only, do not enter if you're human." It is display:block
  // and visibility:visible, so it passes an ordinary visibility test, and its
  // name would happily match a stored portfolio or personal-site answer.
  const honeypot = (el) => {
    if (el.getAttribute('data-automation-id') === 'beecatcher') return true;
    const described = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const text = ((described && described.innerText) || el.getAttribute('aria-label') || '').toLowerCase();
    if (text.includes('for robots only') || text.includes("do not enter if you're human")) return true;
    // Size is only a safe signal for free-text controls. File inputs and the
    // native select behind a custom dropdown are legitimately zero-sized, and
    // rejecting those would break resume upload and working dropdown fills.
    const textLike = el.tagName.toLowerCase() === 'textarea' || ['text', 'email', 'tel', 'url', 'search'].includes(el.type);
    if (!textLike) return false;
    const rect = el.getBoundingClientRect();
    return rect.width < 2 || rect.height < 2;
  };
  // Ashby ships two field-container conventions. Older forms mark the wrapper
  // with a stable class; newer ones use a <fieldset> whose only stable hook is a
  // hashed "_fieldEntry_" class. Matching just the old one silently cost every
  // newer question its label and its required flag, so the run reported nothing
  // missing and then failed validation at submit.
  const ashbyEntry = (el) =>
    el.closest('.ashby-application-form-field-entry') || el.closest('fieldset[class*="_fieldEntry_"]');
  const ashbyTitle = (el) => {
    const entry = ashbyEntry(el);
    return entry ? entry.querySelector('.ashby-application-form-question-title') : null;
  };
  const leverTitle = (el) => {
    const question = el.closest('.application-question');
    return question ? question.querySelector('.application-label .text, .application-label') : null;
  };
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const ashbyBoolean = el.type === 'checkbox' && ashbyEntry(el);
    if (honeypot(el)) return false;
    return ashbyBoolean || (style.display !== 'none' && style.visibility !== 'hidden' && el.type !== 'hidden');
  };
  const labelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    const wrapper = el.closest('label');
    const ashbyLabel = ashbyTitle(el);
    if (ashbyLabel && ashbyLabel.innerText.trim()) return ashbyLabel.innerText.trim();
    const leverLabel = leverTitle(el);
    if (el.type !== 'checkbox' && el.type !== 'radio' && leverLabel && leverLabel.innerText.trim()) {
      return leverLabel.innerText.trim();
    }
    if (wrapper && wrapper.innerText.trim()) return wrapper.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.innerText.trim()) return target.innerText.trim();
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    return el.getAttribute('name') || '';
  };
  const optionLabelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    // Ashby nests the input inside its option label, with no id to point at.
    const wrapper = el.closest('label');
    if (wrapper && wrapper.innerText.trim()) return wrapper.innerText.trim();
    const sibling = el.nextElementSibling;
    if (sibling && sibling.innerText && sibling.innerText.trim()) return sibling.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    return (el.getAttribute('value') || '').trim();
  };
  const groupLabel = (el) => {
    const leverLabel = leverTitle(el);
    if (leverLabel && leverLabel.innerText.trim()) return leverLabel.innerText.trim();
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const selectors = [
        ':scope > legend',
        ':scope > .ashby-application-form-question-title',
        ':scope > label',
      ];
      for (const selector of selectors) {
        const title = fieldset.querySelector(selector);
        if (title && title.innerText.trim()) return title.innerText.trim();
      }
    }
    const entryTitle = ashbyTitle(el);
    if (entryTitle && entryTitle.innerText.trim()) return entryTitle.innerText.trim();
    const radiogroup = el.closest('[role="radiogroup"]');
    const aria = radiogroup && radiogroup.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    // Amazon names a group's question only through aria-labelledby, pointing at
    // a label hidden from assistive tech. Unread, its sponsorship question was
    // matched by the field name REQUIRE_SPONSORSHIP alone, which skips the rule
    // for a definition of sponsorship that names TN.
    const labelledBy = radiogroup && radiogroup.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => (node.innerText || node.textContent || '').trim())
        .join(' ')
        .trim();
      if (text) return text;
    }
    return '';
  };
  // A required multi-select question is satisfied by ticking any one of its
  // boxes, so the options have to be reported as one group. Without this each
  // unticked box counts as its own unmet requirement and a fully answered
  // question still reads as blocking.
  //
  // The container holding the options is ATS-specific, so it is found
  // structurally: the nearest ancestor that holds more than one checkbox and is
  // not the whole form. Keying this off an Ashby-only wrapper meant Greenhouse
  // "select all that apply" groups were never grouped at all - each option
  // arrived as its own required field labelled with the option text, so the
  // question label never matched a drafted answer and the group stayed empty.
  const checkboxGroup = (el) => {
    if (el.type !== 'checkbox') return undefined;
    const entry = ashbyEntry(el);
    if (entry && entry.querySelectorAll('input[type="checkbox"]').length >= 2) return entry;
    // Workday names the group outright. Its options are rendered in a virtual
    // list beside hidden companion inputs, so the structural walk below bails
    // out and every option arrives as its own required field labelled with the
    // option text - which is how the disability form stayed blank.
    const workdayGroup = el.closest('[data-automation-id$="-CheckboxGroup"]');
    if (workdayGroup && workdayGroup.querySelectorAll('input[type="checkbox"]').length >= 2) {
      return workdayGroup;
    }
    let node = el.parentElement;
    while (node && node !== document.body) {
      const boxes = node.querySelectorAll('input[type="checkbox"]').length;
      // Stop before a container that has swallowed unrelated questions.
      if (boxes >= 2) {
        if (node.querySelectorAll('input:not([type="checkbox"]), select, textarea').length > 0) return undefined;
        return node;
      }
      node = node.parentElement;
    }
    return undefined;
  };
  // The question sits above the options, so it is the container text with every
  // option's own text removed.
  const checkboxGroupLabel = (el, container) => {
    const explicit = groupLabel(el);
    if (explicit) return explicit;
    const options = Array.from(container.querySelectorAll('input[type="checkbox"]')).map((box) =>
      optionLabelFor(box),
    );
    const NL = String.fromCharCode(10);
    let text = (container.innerText || '').trim();
    for (const option of options) {
      if (option) text = text.split(option).join(NL);
    }
    const lines = text
      .split(NL)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Workday renders the options inside a bare fieldset and keeps the question
    // outside it, so the container carries no text of its own. Without this the
    // group has no label, every option becomes a standalone required field
    // labelled with its own text, and nothing can answer it.
    return lines[0] || workdayLabel(el) || workdayName(el);
  };
  const out = [];
  // A Workday dropdown button carries no usable label of its own - its text is
  // the placeholder - so the label and the required marker come from the field
  // wrapper that encloses it.
  const workdayField = (el) => el.closest('[data-automation-id^="formField-"]');
  // The wrapper labels its control two different ways. My Information uses a
  // <label for>; the questionnaire steps use <fieldset><legend>, where the
  // question is rich text. Reading only <label> left every questionnaire field
  // nameless, so nothing matched it and nothing reported it as required.
  const workdayLabel = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return '';
    const holder = wrapper.querySelector('label, legend');
    return holder ? holder.innerText.replace(/\\*/g, '').replace(/\\s+/g, ' ').trim() : '';
  };
  const workdayRequired = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return false;
    if (wrapper.querySelector('label abbr, legend abbr')) return true;
    // NVIDIA marks the questionnaire dropdowns only on the control itself.
    return /\\brequired\\b/i.test(el.getAttribute('aria-label') || '');
  };
  // A questionnaire text box has no <label> of its own: its question is the
  // wrapper's legend. Settling for the bare name attribute (or nothing) left
  // Pax8's salary box nameless, so no approved answer could ever claim it.
  const FREE_TEXT = ['text', 'textarea', 'email', 'tel', 'number', 'url'];
  const plainLabel = (el) => {
    const text = labelFor(el);
    if (text && text !== (el.getAttribute('name') || '')) return text;
    if (!FREE_TEXT.includes(String(el.type || '').toLowerCase())) return text;
    // A date's month and year boxes belong to their group, which is labelled
    // and filled as one field; naming the parts would fill the date twice.
    if (el.closest('[data-automation-id="dateInputWrapper"]')) return text;
    return workdayLabel(el) || text;
  };
  // Workday names every field in its automation id, and that name is often the
  // only usable description of what a control asks. The disability checkboxes
  // are legended "Please check one of the boxes below:", which describes no
  // subject at all, while the wrapper is plainly "formField-disabilityStatus".
  const workdayName = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return '';
    return (wrapper.getAttribute('data-automation-id') || '')
      .replace(/^formField-/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .trim();
  };
  controls.filter(visible).forEach((el) => {
    const leverLabel = leverTitle(el);
    const ashbyLabel = ashbyTitle(el);
    // Lever, Ashby and Workday questions often put the part that decides them
    // last: Snap's and Hinge Health's sponsorship questions define sponsorship,
    // TN included or not, after the first 200 characters.
    const labelLimit = leverLabel || ashbyLabel || workdayField(el) ? 2000 : 200;
    const isListbox = el.tagName.toLowerCase() === 'button';
    const isDateGroup = el.getAttribute('data-automation-id') === 'dateInputWrapper';
    const isRadio = el.type === 'radio';
    const container = isListbox || isDateGroup ? null : checkboxGroup(el);
    const optionLabel = (isListbox || isDateGroup
      ? workdayLabel(el) || labelFor(el)
      : isRadio || container
        ? optionLabelFor(el)
        : plainLabel(el)
    ).slice(0, labelLimit);
    const group = isRadio
      ? // A radio group's label is the question itself, and a question's last
        // clause can decide it on any site: Amazon names TN as sponsorship
        // after its first 200 characters, and the cut-off question took the
        // generic sponsorship "No".
        groupLabel(el).slice(0, 2000)
      : container
        ? checkboxGroupLabel(el, container).slice(0, labelLimit)
        : '';
    const label = group || optionLabel;
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || '';
    const questionTitle = (ashbyLabel ? ashbyLabel.innerText.trim()
      : leverLabel ? leverLabel.innerText.trim() : workdayName(el)).slice(0, labelLimit);
    if (!label && !name && !el.id && role !== 'combobox') return;
    const index = out.length;
    el.setAttribute('data-autoapply-idx', String(index));
    out.push({
      selectorIndex: index,
      label,
      optionLabel: group ? optionLabel : undefined,
      questionLabel: questionTitle && questionTitle !== label ? questionTitle : undefined,
      groupKey: container ? (group || undefined) : undefined,
      type: (isDateGroup
        ? 'date'
        : isListbox
          ? 'select'
          : el.tagName.toLowerCase() === 'select'
            ? 'select'
            : el.type || 'text'
      ).toLowerCase(),
      name,
      domId: el.id || undefined,
      required:
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        // Workday marks a radio group only on its question, not on each radio.
        Boolean((isListbox || isDateGroup || isRadio) && workdayRequired(el)) ||
        Boolean(ashbyLabel && String(ashbyLabel.className).includes('_required_')),
      role,
      options: el.tagName.toLowerCase() === 'select'
        ? Array.from(el.options || [])
            .map((o) => (o.textContent || '').replace(/\\s+/g, ' ').trim())
            .filter((t) => t.length > 0)
            .slice(0, 40)
        : undefined,
      value: (isListbox || isDateGroup
        ? el.innerText || ''
        : el.type === 'checkbox' || el.type === 'radio'
          ? el.checked
            ? 'checked'
            : ''
          : el.value || ''
      )
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 120),
    });
  });
  return out;
})()`;
