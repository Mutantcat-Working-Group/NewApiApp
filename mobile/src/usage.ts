/**
 * 从 new-api 的分时用量行里派生「近一小时」「近 24 小时」合计和调用分布。
 *
 * new-api 只提供按小时聚合的原始行（model/usedata.go 把 created_at 向下取整到整点，
 * 同一用户同一模型同一小时的请求合并成一行）。所有汇总都在客户端算，服务端没有
 * 现成的「近一小时」或「调用分布」接口。
 */

import type { QuotaDateItem } from './types';

export type UsageSummary = {
  tokenUsed: number;
  count: number;
};

export type ModelShare = {
  model: string;
  tokenUsed: number;
  count: number;
  share: number;
};

export type HourPoint = {
  timestamp: number;
  tokenUsed: number;
  count: number;
};

export type UsageDerivation = {
  /** 最近一个完整整点到现在的用量。 */
  hour: UsageSummary;
  /** 传入的整段时间的用量合计。 */
  total: UsageSummary;
  /** 按模型聚合的 token 占比，从大到小。 */
  models: ModelShare[];
  /** 按整小时补齐的时间序列，没有用量的整点补 0，折线图才不会断。 */
  hours: HourPoint[];
};

const HOUR_SECONDS = 3600;

function emptySummary(): UsageSummary {
  return { tokenUsed: 0, count: 0 };
}

function floorToHour(timestamp: number): number {
  return timestamp - (timestamp % HOUR_SECONDS);
}

/**
 * 累加落在 [since, now] 内的行。
 * created_at 为 0 的行是服务端没填时间的脏数据，宁可不统计也不要算错。
 */
export function summarizeUsage(items: QuotaDateItem[], since: number, now?: number): UsageSummary {
  const end = now ?? Math.floor(Date.now() / 1000);
  const summary = emptySummary();
  for (const item of items) {
    const createdAt = item.created_at;
    if (!createdAt || createdAt < since || createdAt > end) {
      continue;
    }
    summary.tokenUsed += item.token_used ?? 0;
    summary.count += item.count ?? 0;
  }
  return summary;
}

/**
 * 派生一小时 / 24 小时合计、模型分布和按小时序列。
 *
 * 近一小时就是字面意思：[now - 3600, now]。服务端把用量按整点聚合，
 * 所以这个窗口会跨两个桶，取整点起点反而会漏掉当前这一小时已经发生的调用。
 */
export function deriveUsage(items: QuotaDateItem[], now?: number): UsageDerivation {
  const end = now ?? Math.floor(Date.now() / 1000);
  const hourStart = end - HOUR_SECONDS;
  const dayStart = end - 24 * HOUR_SECONDS;
  const total = summarizeUsage(items, dayStart, end);
  const hour = summarizeUsage(items, hourStart, end);

  const byModel = new Map<string, UsageSummary>();
  const byHour = new Map<number, UsageSummary>();
  for (const item of items) {
    const createdAt = item.created_at;
    if (!createdAt || createdAt < dayStart || createdAt > end) {
      continue;
    }
    const tokenUsed = item.token_used ?? 0;
    const count = item.count ?? 0;
    const model = item.model_name || '未知模型';
    const modelEntry = byModel.get(model) ?? emptySummary();
    modelEntry.tokenUsed += tokenUsed;
    modelEntry.count += count;
    byModel.set(model, modelEntry);

    const bucket = floorToHour(createdAt);
    const hourEntry = byHour.get(bucket) ?? emptySummary();
    hourEntry.tokenUsed += tokenUsed;
    hourEntry.count += count;
    byHour.set(bucket, hourEntry);
  }

  const hours: HourPoint[] = [];
  for (let t = floorToHour(dayStart); t <= floorToHour(end); t += HOUR_SECONDS) {
    const entry = byHour.get(t) ?? emptySummary();
    hours.push({ timestamp: t, tokenUsed: entry.tokenUsed, count: entry.count });
  }

  const models: ModelShare[] = [...byModel.entries()]
    .map(([model, entry]) => ({
      model,
      tokenUsed: entry.tokenUsed,
      count: entry.count,
      share: total.tokenUsed > 0 ? entry.tokenUsed / total.tokenUsed : 0,
    }))
    .sort((a, b) => b.tokenUsed - a.tokenUsed);

  return { hour, total, models, hours };
}

/** 饼图只画得下七八块，其余合并成「其它」。 */
export function topModelShares(models: ModelShare[], limit = 6): ModelShare[] {
  if (models.length <= limit) {
    return models;
  }
  const head = models.slice(0, limit - 1);
  const rest = models.slice(limit - 1);
  const other = rest.reduce<ModelShare>(
    (acc, entry) => ({
      model: '其它',
      tokenUsed: acc.tokenUsed + entry.tokenUsed,
      count: acc.count + entry.count,
      share: acc.share + entry.share,
    }),
    { model: '其它', tokenUsed: 0, count: 0, share: 0 },
  );
  return [...head, other];
}
