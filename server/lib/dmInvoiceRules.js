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

module.exports = {
  BRANCHES,
  ACCOUNTS,
  MODULE_PRICE,
  itemDescription,
  invoiceNoPattern,
  genderFromNric,
  registrationPrice,
  registrationProduct
};
