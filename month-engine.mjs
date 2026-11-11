/** Monthly-course evidence engine. No storage writes, network or audio grading. */
export const STORAGE_KEY = 'chinese-mission-month-v1';
export const COURSE_VERSION = 'month-1-v1';
export const LEGACY_PREFIX = 'chinese-mission-start-v1:';
const DAY = 86_400_000;
const MAX_ATTEMPTS = 10_000;
const TYPES = new Set(['choice', 'tiles', 'digits', 'speak']);
const SKILLS = ['listening', 'reading', 'assembly', 'speaking', 'meaning'];
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const stamp = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const identifier = value => bounded(value, 180) && /^[\p{L}\p{N}_.:/-]+$/u.test(value) && !unsafeKeys.has(value);
function fail(message = 'Файл прогресса имеет неподдерживаемую структуру.') { throw new Error(message); }
function guard(value, depth = 0, budget = {nodes: 0}) {
  if (++budget.nodes > 180_000 || depth > 15) fail('Файл прогресса слишком сложный.');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (!Array.isArray(value) && !plain(value)) fail();
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) fail('Небезопасный ключ в файле прогресса.');
    guard(value[key], depth + 1, budget);
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function timeMap(value = {}) {
  if (!plain(value)) fail();
  const result = {};
  if (Object.keys(value).length > 12) fail();
  for (const [id, time] of Object.entries(value)) {
    if (!/^(?:[1-9]|1[0-2])$/.test(id) || stamp(time, null) === null) fail();
    result[id] = time;
  }
  return result;
}
function secondsMap(value = {}) {
  if (!plain(value) || Object.keys(value).length > 12) fail('Некорректный учёт времени.');
  const result = {};
  for (const [id, seconds] of Object.entries(value)) {
    if (!/^(?:[1-9]|1[0-2])$/.test(id) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 1_000_000_000) fail('Некорректный учёт времени.');
    result[id] = seconds;
  }
  return result;
}
function legacyMap(value = {}) {
  if (!plain(value) || Object.keys(value).length > 1000) fail('Слишком много прежних записей.');
  const result = {};
  let size = 0;
  for (const [key, text] of Object.entries(value)) {
    if (!key.startsWith(LEGACY_PREFIX) || key.length > 300 || typeof text !== 'string') fail('Разрешены только прежние записи Chinese Mission.');
    size += key.length + text.length;
    if (size > 2_000_000) fail('Прежние записи слишком велики.');
    result[key] = text;
  }
  return result;
}
function validResponse(response) {
  return response === null || (typeof response === 'string' && response.length <= 4000)
    || (Array.isArray(response) && response.length <= 100 && response.every(item => bounded(item, 200)));
}
function validAttempt(value) {
  if (!plain(value) || !identifier(value.id) || !identifier(value.activityId) || !identifier(value.unit)
      || !TYPES.has(value.type) || !SKILLS.includes(value.skill) || !validResponse(value.response)
      || stamp(value.at, null) === null || typeof value.helped !== 'boolean'
      || !Number.isInteger(value.plays) || value.plays < 0 || value.plays > 10000
      || ![true, false, null].includes(value.correct) || typeof value.audioVerified !== 'boolean') fail();
  if (value.type === 'speak' && value.correct !== null) fail('Устная попытка не получает автоматический балл.');
  if (value.type !== 'speak' && typeof value.correct !== 'boolean') fail();
  if (value.lessonId !== undefined && (!Number.isInteger(value.lessonId) || value.lessonId < 1 || value.lessonId > 12)) fail();
  return {
    id: value.id, activityId: value.activityId, ...(value.lessonId === undefined ? {} : {lessonId: value.lessonId}),
    unit: value.unit, skill: value.skill, type: value.type,
    response: clone(value.response), correct: value.correct, helped: value.helped,
    plays: value.plays, at: value.at,
    // Neither a learner's recording nor an imported flag verifies their pronunciation.
    audioVerified: value.type === 'speak' ? false : value.audioVerified,
  };
}
function eligible(attempt) {
  return attempt.correct === true && !attempt.helped && attempt.type !== 'speak'
    && (attempt.skill !== 'listening' || attempt.audioVerified);
}
function updateReview(schedule, attempt) {
  const previous = schedule[attempt.unit];
  if (!eligible(attempt)) {
    // Errors and help cannot move an existing review farther into the future.
    schedule[attempt.unit] = previous
      ? {...previous, dueAt: Math.min(previous.dueAt, attempt.at), retained: false, needsPractice: true, lastAttemptAt: attempt.at}
      : {unit: attempt.unit, stage: 0, dueAt: attempt.at, lastSuccessAt: null,
        lastActivityId: null, retained: false, needsPractice: true, lastAttemptAt: attempt.at};
    return;
  }
  if (previous?.lastSuccessAt !== null && previous?.lastSuccessAt !== undefined) {
    const newVariant = attempt.activityId !== previous.lastActivityId;
    // An error/helped attempt also exposes the target. A minute-later correction
    // cannot reuse an old success date to claim delayed retention.
    const delayed = attempt.at - (previous.lastAttemptAt ?? previous.lastSuccessAt) >= DAY;
    if (!newVariant || !delayed) {
      schedule[attempt.unit] = {...previous, lastAttemptAt: attempt.at};
      return;
    }
  }
  const stage = Math.min(3, (previous?.stage ?? 0) + 1);
  const delay = stage === 1 ? 2 * DAY : stage === 2 ? 7 * DAY : 14 * DAY;
  schedule[attempt.unit] = {
    unit: attempt.unit, stage, dueAt: attempt.at + delay, lastSuccessAt: attempt.at,
    lastActivityId: attempt.activityId, retained: stage >= 2, needsPractice: false, lastAttemptAt: attempt.at,
  };
}
function rebuildReview(attempts) {
  const schedule = {};
  for (const attempt of [...attempts].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) updateReview(schedule, attempt);
  return schedule;
}
export function freshState(now = Date.now()) {
  const at = stamp(now, Date.now());
  return {version: 1, courseVersion: COURSE_VERSION, createdAt: at, updatedAt: at,
    attempts: [], completedLessons: {}, creditedLessons: {},
    position: {lesson: 1, section: 0, activity: 0}, reviewSchedule: {}, legacySnapshot: {}, activeSeconds: {}};
}
function validateState(value, now = Date.now()) {
  guard(value);
  if (!plain(value) || value.version !== 1 || value.courseVersion !== COURSE_VERSION
      || !Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) fail();
  const position = value.position;
  if (!plain(position) || !Number.isInteger(position.lesson) || position.lesson < 1 || position.lesson > 12
      || !Number.isInteger(position.section) || position.section < 0 || position.section > 100
      || !Number.isInteger(position.activity) || position.activity < 0 || position.activity > 200) fail();
  const attempts = value.attempts.map(validAttempt);
  if (new Set(attempts.map(item => item.id)).size !== attempts.length) fail('Повторяющиеся идентификаторы попыток.');
  return {version: 1, courseVersion: COURSE_VERSION,
    createdAt: stamp(value.createdAt, now), updatedAt: stamp(value.updatedAt, now),
    attempts, completedLessons: timeMap(value.completedLessons), creditedLessons: timeMap(value.creditedLessons),
    position: {...position}, reviewSchedule: rebuildReview(attempts), legacySnapshot: legacyMap(value.legacySnapshot),
    activeSeconds: secondsMap(value.activeSeconds)};
}
export function readState(storage, now = Date.now()) {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === null || stored === undefined) return {state: freshState(now), warning: null};
    if (typeof stored !== 'string' || stored.length > 8_000_000) fail('Сохранённый прогресс слишком велик.');
    return {state: validateState(JSON.parse(stored), now), warning: null};
  } catch (error) {
    return {state: freshState(now), warning: 'Не удалось прочитать прогресс. Исходная запись сохранена: ' + error.message};
  }
}
let sequence = 0;
export function recordAttempt(state, activity, response, {helped = false, plays = 0, now = Date.now(), audioVerified = false} = {}) {
  if (state.attempts.length >= MAX_ATTEMPTS) fail('История заполнена. Сначала сохрани резервную копию прогресса.');
  if (!activity || !identifier(activity.id) || !identifier(activity.unit) || !TYPES.has(activity.type) || !SKILLS.includes(activity.skill)) fail('Некорректное задание.');
  if (!validResponse(response) || typeof helped !== 'boolean' || !Number.isInteger(plays) || plays < 0 || plays > 10000) fail('Некорректный ответ.');
  let correct;
  if (activity.type === 'speak') correct = null;
  else if (activity.type === 'tiles') {
    if (!Array.isArray(response) || !Array.isArray(activity.answer)) fail('Ответ должен быть последовательностью блоков.');
    correct = response.length === activity.answer.length && response.every((id, index) => id === activity.answer[index]);
  } else {
    if (typeof response !== 'string' || typeof activity.answer !== 'string') fail('Ответ должен быть строкой.');
    if (activity.type === 'digits' && !/^\d{1,12}$/.test(response)) fail('Выбери цифры на панели.');
    correct = response === activity.answer;
  }
  const at = stamp(now, Date.now());
  const attempt = {
    id: `${at.toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    activityId: activity.id, ...(activity.lessonId === undefined ? {} : {lessonId: activity.lessonId}),
    unit: activity.unit, skill: activity.skill, type: activity.type,
    response: clone(response), correct, helped, plays, at,
    audioVerified: activity.type !== 'speak' && audioVerified === true && activity.audio?.review !== 'draft',
  };
  const result = {...state, updatedAt: at, attempts: [...state.attempts, attempt], reviewSchedule: {...state.reviewSchedule}};
  updateReview(result.reviewSchedule, attempt);
  return result;
}
export function markLessonComplete(state, id, now = Date.now()) {
  if (!Number.isInteger(id) || id < 1 || id > 12) fail('Неизвестное занятие.');
  const at = stamp(now, Date.now());
  return {...state, updatedAt: at, completedLessons: {...state.completedLessons, [id]: state.completedLessons[id] ?? at}};
}
export function creditFirstLesson(state, now = Date.now()) {
  const at = stamp(now, Date.now());
  return {...state, updatedAt: at, creditedLessons: {...state.creditedLessons, 1: state.creditedLessons[1] ?? at},
    position: state.position.lesson === 1 ? {lesson: 2, section: 0, activity: 0} : {...state.position}};
}
export function getDueReviews(state, now = Date.now(), limit = 8) {
  const count = Number.isInteger(limit) ? Math.max(0, Math.min(8, limit)) : 8;
  return Object.values(state.reviewSchedule).filter(review => review.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.unit.localeCompare(b.unit)).slice(0, count).map(review => ({...review}));
}
export function summarize(state, activities = []) {
  const scope = Array.isArray(activities) && activities.length ? new Set(activities.map(activity => activity.id)) : null;
  const attempts = scope ? state.attempts.filter(item => scope.has(item.activityId)) : state.attempts;
  const latest = new Map();
  const first = new Map();
  for (const attempt of attempts) {
    if (!first.has(attempt.activityId)) first.set(attempt.activityId, attempt);
    latest.set(attempt.activityId, attempt);
  }
  const bySkill = Object.fromEntries(SKILLS.map(skill => [skill, {
    activities: 0, attempts: attempts.filter(item => item.skill === skill).length,
    independentCorrect: 0, assistedCorrect: 0, incorrect: 0, pending: 0,
    firstCorrect: 0, firstAnswered: 0, verifiedListening: 0, draftListening: 0,
  }]));
  for (const attempt of latest.values()) {
    const row = bySkill[attempt.skill];
    row.activities++;
    if (attempt.correct === null) row.pending++;
    else if (attempt.correct && attempt.helped) row.assistedCorrect++;
    else if (attempt.correct) row.independentCorrect++;
    else row.incorrect++;
    if (attempt.skill === 'listening') row[attempt.audioVerified ? 'verifiedListening' : 'draftListening']++;
    const initial = first.get(attempt.activityId);
    if (initial.correct !== null) { row.firstAnswered++; if (initial.correct && !initial.helped) row.firstCorrect++; }
  }
  const reviews = Object.values(state.reviewSchedule);
  return {bySkill, speaking: {attempts: attempts.filter(item => item.type === 'speak').length,
    activities: [...latest.values()].filter(item => item.type === 'speak').length, verified: 0,
    pending: [...latest.values()].filter(item => item.type === 'speak').length},
    retention: {scheduled: reviews.length, retained: reviews.filter(item => item.retained && !item.needsPractice).length,
      needsPractice: reviews.filter(item => item.needsPractice).length},
    completedLessons: Object.keys(state.completedLessons).length, creditedLessons: Object.keys(state.creditedLessons).length};
}
export function exportProgress(state, legacySnapshot = {}) {
  const validated = validateState(state);
  return {format: 'chinese-mission-progress', version: 1, exportedAt: Date.now(), state: validated,
    legacySnapshot: {...legacyMap(legacySnapshot), ...validated.legacySnapshot}};
}
export function importProgress(current, payload, now = Date.now()) {
  if (typeof payload === 'string') {
    if (payload.length > 8_000_000) fail('Файл прогресса слишком велик.');
    payload = JSON.parse(payload);
  }
  guard(payload);
  if (!plain(payload) || payload.format !== 'chinese-mission-progress' || payload.version !== 1) fail('Это не резервная копия Chinese Mission.');
  // Validate everything before constructing a merge. Caller keeps its original state on failure.
  const existing = validateState(current, now);
  const incoming = validateState(payload.state, now);
  const legacy = legacyMap(payload.legacySnapshot);
  const mergedAttempts = new Map(existing.attempts.map(attempt => [attempt.id, attempt]));
  for (const attempt of incoming.attempts) if (!mergedAttempts.has(attempt.id)) mergedAttempts.set(attempt.id, attempt);
  if (mergedAttempts.size > MAX_ATTEMPTS) fail('Объединённая история слишком велика.');
  const attempts = [...mergedAttempts.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const mergeTimes = (left, right) => {
    const result = {...left};
    for (const [id, time] of Object.entries(right)) result[id] = has(result, id) ? Math.min(result[id], time) : time;
    return result;
  };
  return {...existing, updatedAt: stamp(now, Date.now()), attempts,
    completedLessons: mergeTimes(existing.completedLessons, incoming.completedLessons),
    creditedLessons: mergeTimes(existing.creditedLessons, incoming.creditedLessons),
    // Current browser position and its copies win; import never rewinds current work.
    reviewSchedule: rebuildReview(attempts),
    activeSeconds: Object.fromEntries([...new Set([...Object.keys(existing.activeSeconds), ...Object.keys(incoming.activeSeconds)])]
      .map(id => [id, Math.max(existing.activeSeconds[id] ?? 0, incoming.activeSeconds[id] ?? 0)])),
    legacySnapshot: {...legacy, ...incoming.legacySnapshot, ...existing.legacySnapshot}};
}
export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const value = random();
    const selected = Math.min(index, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * (index + 1))));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}
