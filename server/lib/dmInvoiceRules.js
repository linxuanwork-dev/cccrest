// Encodes the DM REG & MOD business rules (source: the Bukku sales-invoice
// template's "Sheet1" tab). If the user changes Sheet1 in their own copy of
// the template, these rules need updating to match — Sheet1 is the source
// of truth, this file is a readable/executable copy of it.

const BRANCHES = ['TDA', 'TST', 'BBU'];

const ACCOUNTS = {
  registration: '5000-01',
  module: '5000-03'
};

function itemDescription(type, branch, yyyy, mm) {
  if (type === 'registration') return `${branch}-REGISTRATION`;
  if (type === 'module') return `${branch}-MODUL ${yyyy}_${mm}`;
  throw new Error(`Unknown row type: ${type}`);
}

function invoiceNoPattern(type, branch, yy, mm) {
  if (type === 'registration') return `IV-${branch}-R${yy}${mm}-[3DIGIT]`;
  if (type === 'module') return `IV-${branch}-M${yy}${mm}-[3DIGIT]`;
  throw new Error(`Unknown row type: ${type}`);
}

// Last digit of NRIC: odd = male, even = female. NRIC may contain
// non-digit formatting (spaces/dashes) — strip those before checking.
function genderFromNric(nric) {
  const digits = String(nric || '').replace(/\D/g, '');
  if (!digits) return null;
  const lastDigit = Number(digits[digits.length - 1]);
  return lastDigit % 2 === 0 ? 'female' : 'male';
}

const MODULE_PRICE = 80;

function registrationPrice(gender, jersiSize) {
  const isShortJersi = /pendek|short/i.test(jersiSize || '');
  if (gender === 'female' && !isShortJersi) return 210;
  return 200; // male, or female with short jersi
}

function registrationProduct(gender) {
  return gender === 'female' ? 'REGISTRATION-FEMALE' : 'REGISTRATION-MALE';
}

// ---- the same rules, read from the company's settings (migration 058): branches, accounts, numbering, item text, prices ----
// The values below are what this file had before; they are used only while a company has nothing in the settings.
const DEFAULT_FORMAT = {
  invoicePattern: { registration: 'IV-{BRANCH}-R{YY}{MM}-[3DIGIT]', module: 'IV-{BRANCH}-M{YY}{MM}-[3DIGIT]' },
  itemDescription: { registration: '{BRANCH}-REGISTRATION', module: '{BRANCH}-MODUL {YYYY}_{MM}' },
  prices: { module: MODULE_PRICE, registrationMale: 200, registrationFemale: 210 }
};

const fill = (tpl, v) => String(tpl).replace(/\{(BRANCH|YY|YYYY|MM)\}/g, (m, k) => v[k]);

function makeRules(cfg) {
  const c = cfg || {};
  const branches = (c.branches && c.branches.length) ? c.branches : BRANCHES;
  const accounts = Object.assign({}, ACCOUNTS, c.accounts || {});
  const f = c.format || {};
  const pattern = Object.assign({}, DEFAULT_FORMAT.invoicePattern, f.invoicePattern || {});
  const desc = Object.assign({}, DEFAULT_FORMAT.itemDescription, f.itemDescription || {});
  const prices = Object.assign({}, DEFAULT_FORMAT.prices, f.prices || {});
  return {
    BRANCHES: branches,
    ACCOUNTS: accounts,
    MODULE_PRICE: Number(prices.module),
    itemDescription(type, branch, yyyy, mm) {
      if (!desc[type]) throw new Error(`Unknown row type: ${type}`);
      return fill(desc[type], { BRANCH: branch, YYYY: yyyy, MM: mm, YY: String(yyyy).slice(-2) });
    },
    invoiceNoPattern(type, branch, yy, mm) {
      if (!pattern[type]) throw new Error(`Unknown row type: ${type}`);
      return fill(pattern[type], { BRANCH: branch, YY: yy, MM: mm, YYYY: '' });
    },
    registrationPrice(gender, jersiSize) {
      const isShortJersi = /pendek|short/i.test(jersiSize || '');
      if (gender === 'female' && !isShortJersi) return Number(prices.registrationFemale);
      return Number(prices.registrationMale);
    },
    registrationProduct,
    genderFromNric
  };
}

/* the rules of one company, from branches / account_mappings / company_settings */
async function forCompany(companyId, db) {
  const { pool } = require('../db');
  const q = db || pool;
  const branches = require('./branches');
  const settings = require('./settings');
  const codes = await branches.codes(companyId, q);
  const maps = (await q.query("SELECT source_name, target_account FROM account_mappings WHERE company_id = $1 AND kind = 'dm_invoice'", [companyId])).rows;
  const accounts = {}; maps.forEach((m) => { if (m.target_account) accounts[m.source_name] = m.target_account; });
  const format = await settings.get(companyId, 'dm_invoice', null, q);
  return makeRules({ branches: codes, accounts, format: format || undefined });
}

module.exports = {
  makeRules,
  forCompany,
  DEFAULT_FORMAT,
  BRANCHES,
  ACCOUNTS,
  MODULE_PRICE,
  itemDescription,
  invoiceNoPattern,
  genderFromNric,
  registrationPrice,
  registrationProduct
};
