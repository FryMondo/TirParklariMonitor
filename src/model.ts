import { z } from 'zod';
const slotSchema = z.object({ baslangicDakika: z.number().int().min(0).max(1439), baslangic: z.string(), bitis: z.string(), kapasite: z.number().int().nonnegative(), kalan: z.number().int().nonnegative(), acik: z.boolean(), kapali: z.boolean() });
const responseSchema = z.object({ gun: z.string(), dilimDakika: z.number().int().positive(), gunKapasite: z.number().int().nonnegative(), gunKalan: z.number().int().nonnegative(), gunAlinabilir: z.number().int().nonnegative(), dilimler: z.array(slotSchema), sunucuZamani: z.string() });
export type Slot = z.infer<typeof slotSchema>;
export type Status = 'AVAILABLE' | 'OCCUPIED' | 'UNKNOWN';
export function classify(s: Slot): Status {
  if (s.kalan > 0 && s.acik && !s.kapali) return 'AVAILABLE';
  if (s.kalan === 0 && !s.acik && !s.kapali) return 'OCCUPIED';
  return 'UNKNOWN';
}
function minutes(time: string, end: boolean): number {
  if (end && time === '24:00') return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Некоректний час: ${time}`);
  return Number(time.slice(0,2))*60+Number(time.slice(3));
}
export function parseResponse(raw: unknown, date: string) {
  const data = responseSchema.parse(raw);
  if (data.gun !== date) throw new Error(`Дата відповіді ${data.gun} не збігається з ${date}`);
  const seen = new Set<string>();
  for (const s of data.dilimler) {
    const start = minutes(s.baslangic, false), end = minutes(s.bitis, true);
    if (start !== s.baslangicDakika || end <= start || s.kalan > s.kapasite) throw new Error(`Некоректний інтервал ${s.baslangic}–${s.bitis}`);
    const key = `${s.baslangic}|${s.bitis}`;
    if (seen.has(key)) throw new Error(`Дублікат інтервалу ${key}`);
    seen.add(key);
  }
  return data;
}
