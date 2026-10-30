/* Language switch for the KWSP & PERKESO page. The page is written in Chinese; when the CC CREST app is in
   English every Chinese text on the page (labels, buttons, messages, warnings) is shown in English instead.
   The app tells the page which language to use: ?lang=en|zh in the URL and a 'kwsp-lang' message on switch. */
(function () {
  'use strict';
  const CJK = /[　-鿿＀-￯]/;

  // Sentences with numbers / names in them, applied first.
  const RULES = [
    [/正在识别扫描件（OCR）… 第 (\d+) \/ (\d+) 页/g, 'Reading the scan (OCR)… page $1 / $2'],
    [/已生成 (\d+) 页，正在下载…/g, 'Generated $1 pages, downloading…'],
    [/已自动保存 (\S+)/g, 'Saved automatically at $1'],
    [/已保存「(.*)」/g, 'Saved "$1"'],
    [/已打开「(.*)」/g, 'Opened "$1"'],
    [/已导入 (.*)（按「保存」才会存进系统）/g, 'Imported $1 (press "Save" to store it in the system)'],
    [/已读取 (\d+) 个文件/g, 'Read $1 file(s)'],
    [/(\d+) 人 · /g, '$1 employee(s) · '],
    [/^(\s*)(\d+) 页$/g, '$1$2 pg'],
    [/地址第 (\d) 行/g, 'Address line $1'],
    [/分行 (\d) 名称/g, 'Branch $1 name'],
    [/分行 (\d) 地址/g, 'Branch $1 address'],
    [/电话 (\d)/g, 'Phone $1'],
    [/」(\d+) 行放不下，已截断/g, '" — $1 lines do not fit, truncated'],
    [/」太长（(\d+\/\d+) 格），已截断/g, '" is too long ($1 cells), truncated'],
    [/」太长，已截断/g, '" is too long, truncated'],
    [/」放不下，已截断/g, '" does not fit, truncated'],
    [/\(第 (\d+) 页\)/g, '(page $1)'],
    [/员工 (\d+)（/g, 'Employee $1 ('],
    [/员工 (\d+) /g, 'Employee $1 '],
    [/公司名称两处读到的不一样：「(.*)」和「(.*)」，已用证书上的，请核对。/g, 'The company name was read differently in two places: "$1" and "$2"; the certificate version was used — please check.'],
    [/注册号读到「(.*)」，不是 12 位数字，请核对。/g, 'Registration no. read as "$1", which is not 12 digits — please check.'],
    [/董事 (\d+)（(.*)）的 IC 读到「(.*)」，请核对。/g, 'Director $1 ($2): IC read as "$3" — please check.'],
    [/董事 (.+)：/g, 'Director $1: '],
    [/^(\s*)东主 (?!\/)/g, '$1Owner '],
    [/^(\s*)联络人 (?!\/)/g, '$1Contact officer '],
    [/你的权限不足（(?:这个操作|修改已保存的资料)需要 L(\d) 或以上）/g, 'Your access level is not enough (L$1 or above is needed for this).']
  ];

  // Whole-text matches (short words that must not be replaced inside longer sentences).
  const EXACT = new Map(Object.entries({
    '州': 'State', '城市': 'City', '邮区': 'Postcode', '全名': 'Full name', '职位': 'Position', '电话': 'Phone', '手机': 'Mobile',
    '电邮': 'Email', '传真': 'Fax', '国籍': 'Nationality', '删除': 'Delete', '性别': 'Gender', '种族': 'Race', '员工': 'Employee',
    '董事': 'Directors', '地址': 'Addresses', '姓名': 'Name', '业务': 'Business', '预览': 'Preview', '自动': 'auto', '移除': 'Remove',
    '证件': 'ID type', '月薪': 'Monthly salary', '全选': 'Select all', '全不选': 'Select none', '营业地址': 'Business address',
    '注册地址': 'Registered address', '通讯地址': 'Mailing address', '自己填': 'Fill in myself', '已删除': 'Deleted', '联络人': 'Contact officer'
  }));

  // Phrases replaced inside longer texts (longest first).
  const PHRASES = Object.entries({
    '填一次资料，自动填好 8 份官方表格（全部大写），下载后直接打印': 'Enter the data once, all 8 official forms are filled in automatically (all caps) — download and print',
    '开户表格': 'Employer Registration Forms',
    '已保存的资料': 'Saved data', '已保存的客户': 'Saved data',
    '保存客户': 'Save', '新客户': 'New', '导出 .json': 'Export .json', '导入 .json': 'Import .json', '确定删除？': 'Confirm delete?',
    '从 SSM 文件导入': 'Import from SSM documents',
    '选择或拖入 SSM Certificate 和 Section 14 的 PDF': 'Choose or drop the SSM Certificate and Section 14 PDFs',
    '（可多选；扫描件或手机拍的照片也可以，会自动识别文字）': '(multiple files OK; scans and phone photos work too — the text is read automatically)',
    '正在加载识别组件（首次约 7 MB）…': 'Loading the text-recognition component (about 7 MB the first time)…',
    '自动带入公司名称、注册号、成立日期、业务、注册地址、电邮、电话和董事。文件只在这台电脑上读取，不会上传。':
      'Fills in company name, registration no., incorporation date, business, registered address, email, phone and directors. Files are read on this computer only and are not uploaded.',
    '选择要用哪一位': 'choose which one to use',
    '注册地址一定会填进 KWSP「Alamat Berdaftar」，营业和通讯地址由你选':
      'The registered address is always written into KWSP "Alamat Berdaftar"; you choose the business and mailing addresses',
    '带入表格': 'Apply to form',
    '带入后请核对，文件里没有的资料（电话、员工等）照常手填。': 'Please check after applying; details not in the documents (phone, employees, etc.) are filled in by hand as usual.',
    '1. 公司资料': '1. Company details', '公司全名': 'Full company name', 'SSM 注册号': 'SSM registration no.', '成立日期': 'Incorporation date',
    '首位员工入职': 'First employee joined', '公司类型': 'Company type', '(独资)': '(Sole proprietor)', '(合伙)': '(Partnership)', '(其他)': '(Other)',
    '注册机构': 'Registered with', '其他类型说明': 'Other type (describe)', '业务性质': 'Nature of business', '员工人数': 'No. of employees',
    '公司电话': 'Company phone', '公司手机': 'Company mobile', '公司电邮': 'Company email',
    '2. 地址': '2. Addresses', '营业地址': 'Business address', '注册地址同营业地址': 'Registered address same as business address',
    '通讯地址同营业地址': 'Mailing address same as business address', '注册地址': 'Registered address', '通讯地址': 'Mailing address',
    '3. 分行': '3. Branches', '有其他分行（没有就不勾，KWSP 第 3 页 F 部分留空）': 'Has other branches (leave unticked if none; KWSP page 3 part F stays blank)',
    '4. 联络人': '4. Contact officer', 'IC / 护照号': 'IC / passport no.', 'IC / 护照': 'IC / passport',
    '5. 东主 / 董事': '5. Owner / Director',
    '6. i-Akaun 管理员 & PERKESO Portal 申请人': '6. i-Akaun administrator & PERKESO Portal applicant',
    '同联络人（TAC 号码用联络人手机）': 'Same as contact officer (TAC number uses the officer\'s mobile)', '办公室电话': 'Office phone', 'TAC 手机号': 'TAC mobile no.',
    '7. 签署人': '7. Signatory', '同东主 / 董事': 'Same as owner / director', '签署日期': 'Signing date',
    '8. PERKESO 设定': '8. PERKESO settings', 'Portal 申请类型': 'Portal application type',
    '新申请': '(new application)', '更新': '(update)', '雇主类别': 'Employer category', '总公司': '(head office)', '分行': '(branch)', '缴款方式': 'Payment method',
    'PERKESO 雇主编号（已有才填）': 'PERKESO employer code (only if already issued)', '（SIP 1A 用）': ' (for SIP 1A)',
    '新开户一般留空。Borang 2 / SIP 2 右上角的 “No Kod Majikan / MyCoID” 没有雇主编号时会填 SSM 注册号。':
      'Normally left blank for a new registration. The "No Kod Majikan / MyCoID" at the top right of Borang 2 / SIP 2 uses the SSM registration no. when there is no employer code.',
    '9. 员工': '9. Employees', '+ 加员工': '+ Add employee',
    'MyKad 会自动算出生日期和性别。月薪选「超过 RM3,000」只在 Borang 2 打勾；选「超过 RM4,000」三份都打勾。每页 10 人，超过自动加页。':
      'MyKad automatically gives date of birth and gender. "Over RM3,000" is ticked on Borang 2 only; "Over RM4,000" is ticked on all three forms. 10 people per page; extra pages are added automatically.',
    '出生日期': 'Date of birth', '入职日期': 'Start date', '姓名（同 IC）': 'Name (as on IC)', 'L 男': 'L Male', 'P 女': 'P Female',
    'RM3,000 或以下': 'RM3,000 or below', '超过 RM3,000': 'Over RM3,000', '超过 RM4,000': 'Over RM4,000',
    '护照（外劳）': '(passport — foreign worker)',
    '要打印的表格': 'Forms to print', '生成 PDF': 'Generate PDF',
    '打印：用 A4 纸、「实际大小 / 100%」。签名和公司印章打印后亲手补上。': 'Print on A4 at "Actual size / 100%". Add signatures and the company stamp by hand after printing.',
    '按「生成 PDF」后在这里预览': 'Press "Generate PDF" to preview here',
    '请至少选一份表格。': 'Please select at least one form.',
    'PDF 组件没有加载成功，请检查网络后重新打开页面。': 'The PDF component failed to load; check the network and reopen the page.',
    '生成中…': 'Generating…', '已下载 ': 'Downloaded ', '生成失败：': 'Generation failed: ',
    '已取消下载。可再按「生成 PDF」。': 'Download cancelled. Press "Generate PDF" again.', '下载没有成功：': 'Download failed: ',
    '预览组件没有加载，PDF 已正常生成。': 'The preview component did not load; the PDF was generated normally.',
    '预览失败，但 PDF 已正常生成。': 'Preview failed, but the PDF was generated normally.',
    '公司电话和手机都没填。': 'Company phone and mobile are both empty.', '公司电邮没填。': 'Company email is empty.', '营业地址不完整。': 'Business address is incomplete.',
    '没填：': ' missing: ', '种族 Bangsa': 'Race (Bangsa)',
    '请先填公司名称再保存。': 'Please enter the company name before saving.', '保存失败：': 'Save failed: ', '先从左边选一份已保存的资料。': 'Select a saved data set first.',
    '删除失败：': 'Delete failed: ', '已导出 ': 'Exported ', '导出失败': 'Export failed', '这个文件不是有效的客户资料 .json': 'This file is not a valid client data .json file',
    'PDF 读取组件没有加载，请检查网络后重新打开页面。': 'The PDF reader failed to load; check the network and reopen the page.',
    '读不到 ': 'Cannot read ',
    '这个 PDF 只有图片、没有文字层，读不到内容。请用 CamScanner 导出 PDF（会带文字识别），或用 SSM 下载的 PDF。':
      'This PDF contains only images, with no text layer, so it cannot be read. Export the PDF from CamScanner (with text recognition) or use the PDF downloaded from SSM.',
    '有改动，稍后自动保存…': 'Changes pending — saving automatically…', '改动会自动保存。': 'Changes are saved automatically.',
    '没有保存权限，改动不会存进系统（可导出 .json）。': 'You do not have permission to save; changes are not stored (use Export .json).',
    '填了公司名称才会自动保存。': 'Auto-save starts once the company name is filled in.', '自动保存失败：': 'Auto-save failed: ',
    '已自动带入 SSM 资料。黄色框是还要填的资料，请核对，有误可直接修改。': 'SSM data filled in automatically. Yellow boxes still need to be filled in — please check, and edit anything that is wrong.',
    '按所选重新带入': 'Re-apply with these choices',
    '选择联络人': 'Choose the contact officer', '选择东主 / 董事': 'Choose the owner / director', '自己填（手动输入）': 'Fill in myself (type it in)',
    '在下面第 4、5 项选择联络人和东主': 'choose the contact officer and owner in sections 4 and 5 below',
    '读取后已自动填进下面的表格，请核对，有误可直接修改。想换联络人或东主，在下面第 4、5 项直接选择；想换地址，改上面的地址选择再按这个按钮。文件里没有的资料（电话、员工等）照常手填。':
      'The form below has been filled in automatically — please check it, and edit anything that is wrong. To use a different contact officer or owner, choose one in sections 4 and 5 below; to use a different address, change the address choices above and press this button. Details not in the documents (phone, employees, etc.) are filled in by hand as usual.',
    '读取后已自动填进下面的表格，请核对，有误可直接修改。想换董事或地址，改上面的选择再按这个按钮。文件里没有的资料（电话、员工等）照常手填。':
      'The form below has been filled in automatically — please check it, and edit anything that is wrong. To use a different director or address, change the choices above and press this button. Details not in the documents (phone, employees, etc.) are filled in by hand as usual.',
    '生成 KWSP 授权信': 'Generate KWSP authorization letter', '生成授权信中…': 'Generating the letter…', '已生成授权信，正在下载…': 'Letter generated, downloading…',
    '授权信：公司名称没填。': 'Authorization letter: the company name is empty.', '授权信：联络人姓名没填（第 4 项）。': 'Authorization letter: the contact officer name is empty (section 4).',
    '授权信：联络人 IC 没填（第 4 项）。': 'Authorization letter: the contact officer IC is empty (section 4).', '授权信：东主 / 董事姓名没填（第 5 项）。': 'Authorization letter: the owner / director name is empty (section 5).',
    '读取中… 请稍等': 'Reading… please wait', '读取 SSM 文件失败：': 'Could not read the SSM files: ',
    '没有读到公司名称。': 'Company name not found.', '没有读到董事资料（Particulars of Director）。': 'Director details (Particulars of Director) not found.',
    '公司名称': 'Company name', '注册号': 'Registration no.', '秘书电邮': 'Secretary email', '秘书电话': 'Secretary phone', '（不带入）': ' (not applied)',
    '东主 / 签署人': 'Owner / signatory', '联络人 / i-Akaun': 'Contact officer / i-Akaun',
    '联络人不是董事（例如公司秘书或会计）': 'Contact officer is not a director (e.g. company secretary or accountant)', '联络人自己填': 'Contact officer filled in by me',
    '注册地址（多数是秘书地址）：': 'Registered address (usually the secretary\'s address): ', '营业地址：': 'business address: ',
    '自己填（实际营业地点）': 'Fill in myself (actual business location)', '同营业地址': 'Same as business address',
    '已带入 SSM 资料。黄色框是还要填的资料。': 'SSM data applied. Yellow boxes still need to be filled in.', '缺少公司编号。': 'Missing company id.', '读取失败：': 'Load failed: ',
    '超过 PERKESO 表格的格子数，会被截断': 'More than the PERKESO form cells; it will be truncated',
    '你没有权限使用这个页面': 'You do not have permission to use this page',
    // labels used in the generated-PDF warnings
    '联络人姓名': 'Contact officer name', '东主姓名': 'Owner name', '管理员姓名': 'Administrator name', '申请人姓名': 'Applicant name',
    '联络人 IC': 'Contact officer IC', '东主 IC': 'Owner IC', '管理员 IC': 'Administrator IC', '申请人 IC': 'Applicant IC',
    '联络人职位': 'Contact officer position', '东主职位': 'Owner position', '管理员电话': 'Administrator phone', '管理员手机': 'Administrator mobile',
    'TAC 号码': 'TAC number', '联络人手机': 'Contact officer mobile', '联络人传真': 'Contact officer fax', 'PERKESO 雇主编号': 'PERKESO employer code',
    '营业地址(A3)': 'Business address (A3)', '业务': 'Business', '传真': 'Fax', '国籍': 'Nationality', '邮区': 'Postcode', '城市': 'City', '州': 'State',
    '职位': 'Position', '性别': 'Gender', '种族': 'Race', '董事': 'Director', '管理员': 'administrator', '申请人': 'applicant', '地址': 'Addresses', '出生': 'birth'
  })
    .sort((a, b) => b[0].length - a[0].length);

  const PUNCT = [['（', ' ('], ['）', ')'], ['「', '"'], ['」', '"'], ['“', '"'], ['”', '"'], ['，', ', '], ['。', '. '], ['：', ': '], ['、', ', '], ['；', '; '], ['？', '?']];

  function tr(s) {
    if (!CJK.test(s)) return s;
    let o = s;
    for (const [re, rep] of RULES) o = o.replace(re, rep);
    if (CJK.test(o)) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(o);
      if (EXACT.has(m[2])) return m[1] + EXACT.get(m[2]) + m[3];
      for (const [zh, en] of PHRASES) if (o.includes(zh)) o = o.split(zh).join(en);
    }
    for (const [zh, en] of PUNCT) if (o.includes(zh)) o = o.split(zh).join(en);
    o = o.replace(/ {2,}/g, ' ').replace(/ ([,:;)])/g, '$1').replace(/\( /g, '(');
    return /\s$/.test(s) ? o : o.replace(/ +$/, '');
  }

  let lang = 'zh', busy = false;
  const orig = new WeakMap();                       // text node -> its Chinese text
  const ATTRS = ['placeholder', 'aria-label', 'title'];
  const TITLE_ZH = document.title;

  function xNode(n) {
    if (n.nodeType === 3) {
      if (lang === 'en') {
        const v = n.nodeValue;
        if (CJK.test(v)) { const t = tr(v); if (t !== v) { orig.set(n, v); n.nodeValue = t; } }
      } else if (orig.has(n)) { n.nodeValue = orig.get(n); orig.delete(n); }
    } else if (n.nodeType === 1) {
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      for (const a of ATTRS) {
        if (!n.hasAttribute(a)) continue;
        const key = 'zh' + a.replace(/-/g, '');
        if (lang === 'en') {
          const v = n.getAttribute(a);
          if (CJK.test(v)) { const t = tr(v); if (t !== v) { n.dataset[key] = v; n.setAttribute(a, t); } }
        } else if (n.dataset[key] != null) { n.setAttribute(a, n.dataset[key]); delete n.dataset[key]; }
      }
      n.childNodes.forEach(xNode);
    }
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    busy = true;
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh');
    document.title = lang === 'en' ? 'KWSP & PERKESO Employer Registration Forms' : TITLE_ZH;
    xNode(document.body);
    busy = false;
  }

  new MutationObserver((muts) => {
    if (busy || lang !== 'en') return;
    busy = true;
    for (const m of muts) {
      if (m.type === 'characterData') xNode(m.target);
      else if (m.type === 'attributes') xNode(m.target);
      else m.addedNodes.forEach(xNode);
    }
    busy = false;
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data && e.data.type === 'kwsp-lang') setLang(e.data.lang);
  });
  window.KwspLang = { setLang, tr };
  setLang(new URLSearchParams(location.search).get('lang'));
})();
