// Payment export: receipt numbers run by Bukku, double knock-off warning (Nov 2026). [English, Bahasa Melayu].
// No quote characters inside the translations: they are put back into the page code.
module.exports = {
  '号码谁来排': ['Who numbers the receipts', 'Siapa menomborkan resit'],
  'Bukku 自己排（推荐）': ['Bukku numbers them (recommended)', 'Bukku menomborkan (disyorkan)'],
  '系统排（可以设起始号码）': ['The system numbers them (a start number can be set)', 'Sistem menomborkan (nombor permulaan boleh ditetapkan)'],
  '= branch（BBU / TDA / TST，按学生所在的 branch），[YY][MM][3DIGIT] 原样写进文件，让 Bukku 自己按月跑号，不会重复。要由系统排号的话，号码谁来排选「系统排」：导出时会问每个系列从哪个号码开始，同一笔再导出号码不变。Item Description：': ['= branch (BBU / TDA / TST, the branch of the student), [YY][MM][3DIGIT] is written into the file as it is so Bukku runs the numbers by month itself and they never repeat. To let the system number them, choose The system numbers them: the export then asks where each series starts, and the same payment exported again keeps its number. Item Description:', '= cawangan (BBU / TDA / TST, cawangan murid), [YY][MM][3DIGIT] ditulis dalam fail seperti asal supaya Bukku menjalankan nombor mengikut bulan sendiri dan tidak berulang. Untuk sistem menomborkan, pilih Sistem menomborkan: eksport akan bertanya setiap siri bermula dari nombor mana, dan bayaran yang sama dieksport semula kekal nombornya. Item Description:'],
  '⚠ 提醒：': ['⚠ Reminder: ', '⚠ Peringatan: '],
  '这笔 RM': ['this payment of RM', 'bayaran RM'],
  '要 knock 发票': ['is to knock off invoice', 'akan menolak invois'],
  '，但这张发票之前已经导出过一次 knock（': [', but this invoice was already exported once to be knocked off (', ', tetapi invois ini sudah pernah dieksport untuk ditolak ('],
  '）。如果那笔付款还没导入 Bukku，这样会重复 knock；已经导入的话请不用理会。': ['). If that payment is not imported into Bukku yet, it will be knocked off twice; if it is already imported, please ignore this.', '). Jika bayaran itu belum diimport ke Bukku, ia akan ditolak dua kali; jika sudah diimport, sila abaikan.']
};
