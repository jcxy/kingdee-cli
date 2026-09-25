/**
 * formId 别名表：让使用者（和 AI agent）用业务名而非金蝶内部编码。
 * 初始数据源为中台 acerp 的 KingdeeFormIdEnum 枚举 + 常用查询单据。
 */
export interface FormAlias {
  alias: string;
  formId: string;
  /** 中文业务名（来自中台枚举） */
  label: string;
}

export const FORM_ALIASES: FormAlias[] = [
  { alias: 'sales-order', formId: 'SAL_SaleOrder', label: '销售订单' },
  { alias: 'sal-outstock', formId: 'SAL_OUTSTOCK', label: '销售出库单' },
  { alias: 'sal-returnstock', formId: 'SAL_RETURNSTOCK', label: '销售退货单' },
  { alias: 'ar-receivable', formId: 'AR_receivable', label: '应收单' },
  { alias: 'ar-receivebill', formId: 'AR_RECEIVEBILL', label: '收款单' },
  { alias: 'ar-refundbill', formId: 'AR_REFUNDBILL', label: '收款退款单' },
  { alias: 'inventory', formId: 'STK_Inventory', label: '即时库存' },
  { alias: 'transfer-direct', formId: 'STK_TransferDirect', label: '直接调拨单' },
  { alias: 'transfer-out', formId: 'STK_TRANSFEROUT', label: '分布式调出单' },
  { alias: 'other-outstock', formId: 'STK_MisDelivery', label: '其他出库单' },
  { alias: 'other-instock', formId: 'STK_MISCELLANEOUS', label: '其他入库单' },
  { alias: 'rate', formId: 'BD_Rate', label: '汇率' },
  { alias: 'material', formId: 'BD_MATERIAL', label: '物料' },
];

const byAlias = new Map(FORM_ALIASES.map((a) => [a.alias, a]));
const byFormId = new Map(FORM_ALIASES.map((a) => [a.formId, a]));

export interface ResolvedForm {
  /** 解析后的金蝶 formId */
  formId: string;
  /** 输入是否命中已知别名或已知 formId */
  known: boolean;
  /** 命中的别名（未命中时为 undefined） */
  matched?: FormAlias;
}

/**
 * 解析 --form 参数：别名优先，其次已知 formId，未知则原样透传。
 * 未知透传是刻意设计：金蝶有几百种单据，别名表只覆盖常用的；
 * 调用方应在 stderr 提示透传事实，避免用户拼错别名而不自知。
 */
export function resolveFormId(input: string): ResolvedForm {
  const trimmed = input.trim();
  const hit = byAlias.get(trimmed) ?? byFormId.get(trimmed);
  if (hit) {
    return { formId: hit.formId, known: true, matched: hit };
  }
  return { formId: trimmed, known: false };
}

/** 列出全部别名（config 或 --list 别名场景复用） */
export function listAliases(): FormAlias[] {
  return FORM_ALIASES;
}
