/**
 * `MtopTap` delivers one tapped reply to exactly one consumer: a `take` already waiting for that API,
 * else the per-API queue. Pinned on the real class because the search path relies on it: `typeSearch`
 * registers a waiter at Enter and `searchItems` hands that reply on, so a reply that were also queued
 * would come back out of the next `take` -- the pager walk's -- as if it were a later page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MtopTap } from '../src/browser.ts';

const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search';
const reply = (tag: number) => ({ api: SEARCH_API, ret: 'SUCCESS::调用成功', ok: true, data: { tag } });

test('a reply claimed by a waiting take is not also queued for the next take', async () => {
  const tap = new MtopTap();
  const waiting = tap.take(SEARCH_API, 1000);
  tap.record(reply(1));
  assert.deepEqual(await waiting, reply(1), 'the waiter was answered');
  assert.equal(await tap.take(SEARCH_API, 0), null, 'the same reply is not served twice');
});

test('a reply with no waiter is queued, and the queue serves it exactly once', async () => {
  const tap = new MtopTap();
  tap.record(reply(1));
  assert.deepEqual(await tap.take(SEARCH_API, 0), reply(1), 'the queue held it for the first take');
  assert.equal(await tap.take(SEARCH_API, 0), null, 'and not for a second');
});
