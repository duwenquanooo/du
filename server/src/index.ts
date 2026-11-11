import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const app = express();
const PORT = 3000;

const DATA_PATH = path.join(__dirname, '..', '..', 'du.json');

// du.json contains trailing commas, which strict JSON.parse rejects
function parseLenientJson(raw: string): any {
  return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
}

let db: any = null;
let persons: any[] = [];

// lowest-id search starts here; persisted as next_id on the object
// holding the person array (forward-only: freed low ids are not reused)
let nextIdCursor = 0;
let personHolder: any = null;

// children are derived from parent[] references (the children field in
// du.json is stale in places), parent[] is the source of truth
let childrenIndex = new Map<number, number[]>();

function rebuildChildrenIndex() {
  childrenIndex = new Map();
  for (const p of persons) {
    const id = toInt(p.id);
    for (const pid of validIds(p.parent)) {
      let list = childrenIndex.get(pid);
      if (!list) childrenIndex.set(pid, (list = []));
      list.push(id);
    }
  }
}

function getPersonArray(): { arr: any[]; holder: any } | null {
  if (Array.isArray(db?.earth?.person)) return { arr: db.earth.person, holder: db.earth };
  if (Array.isArray(db?.earth) && Array.isArray(db.earth[0]?.person)) return { arr: db.earth[0].person, holder: db.earth[0] };
  if (Array.isArray(db?.person)) return { arr: db.person, holder: db };
  return null;
}

function loadData() {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  db = parseLenientJson(raw);
  const found = getPersonArray();
  if (!found) throw new Error('Cannot find person array in du.json');
  persons = found.arr;
  personHolder = found.holder;
  for (const p of persons) {
    if (!Array.isArray(p.parent)) p.parent = [];
  }
  const stored = Number(personHolder.next_id);
  nextIdCursor = Number.isSafeInteger(stored) && stored >= 0 ? stored : lowestFreeId(usedIdSet(), 0);
  rebuildChildrenIndex();
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

loadData();

function toInt(val: any): number {
  return Number(val);
}

function usedIdSet(): Set<number> {
  return new Set(persons.map(p => toInt(p.id)));
}

function lowestFreeId(used: Set<number>, from: number): number {
  let id = from;
  while (used.has(id)) id++;
  return id;
}

function allocatePersonId(): number {
  const id = lowestFreeId(usedIdSet(), nextIdCursor);
  nextIdCursor = id + 1;
  personHolder.next_id = nextIdCursor;
  return id;
}

function validIds(arr: any): number[] {
  return (arr || []).map(toInt).filter((x: number) => x >= 0);
}

function toPerson(p: any): any {
  return {
    id: toInt(p.id),
    name: p.name || '',
    birth_date: p.birth_date || '',
    dead_date: p.dead_date || '',
    籍贯: p['籍贯'] || '',
    famous: p['famous'] || '',
    great_person: p['great_person'] || '',
    detail: p.detail || '',
    parent: validIds(p.parent),
    children: (childrenIndex.get(toInt(p.id)) || []).slice().sort((a, b) => a - b),
  };
}

function findPerson(id: number): any {
  return persons.find(p => toInt(p.id) === id);
}

function removeRef(list: any[], id: number) {
  const idx = list.findIndex(x => toInt(x) === id);
  if (idx >= 0) list.splice(idx, 1);
}

function addRef(list: any[], id: number) {
  if (!list.some(x => toInt(x) === id)) list.push(id);
}

app.use(cors());
app.use(express.json());

app.get('/api/persons', (_req, res) => {
  res.json(persons.slice().sort((a, b) => toInt(a.id) - toInt(b.id)).map(toPerson));
});

app.get('/api/persons/search', (req, res) => {
  const name = ((req.query.name as string) || '').trim().toLowerCase();
  const exact = req.query.exact === 'true';
  const filtered = persons.filter(p => {
    const n = (p.name || '').toLowerCase();
    return exact ? n === name : n.includes(name);
  });
  res.json(filtered.sort((a, b) => toInt(a.id) - toInt(b.id)).map(toPerson));
});

app.get('/api/persons/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const p = findPerson(id);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  res.json(toPerson(p));
});

app.post('/api/persons', (req, res) => {
  const { name, birth_date, dead_date, parent, children, native_place } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const newId = allocatePersonId();
  const newPerson: any = {
    id: newId,
    name,
    birth_date: birth_date || '',
    dead_date: dead_date || '',
    '籍贯': native_place || '四川泸县',
    'famous': '',
    'great_person': '',
    parent: [],
  };

  if (Array.isArray(parent)) {
    for (const parentId of parent) {
      const pid = toInt(parentId);
      if (pid >= 0 && findPerson(pid)) addRef(newPerson.parent, pid);
    }
  }
  if (Array.isArray(children)) {
    for (const childId of children) {
      const cid = toInt(childId);
      const child = findPerson(cid);
      if (cid >= 0 && child) addRef(child.parent, newId);
    }
  }

  persons.push(newPerson);
  rebuildChildrenIndex();
  saveData();
  res.status(201).json(toPerson(newPerson));
});

app.put('/api/persons/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const p = findPerson(id);
  if (!p) return res.status(404).json({ error: 'Person not found' });

  const { name, birth_date, dead_date, parent, children, native_place } = req.body;
  if (name !== undefined) p.name = name;
  if (birth_date !== undefined) p.birth_date = birth_date;
  if (dead_date !== undefined) p.dead_date = dead_date;
  if (native_place !== undefined) p['籍贯'] = native_place;

  if (parent !== undefined && Array.isArray(parent)) {
    p.parent = [];
    for (const parentId of parent) {
      const pid = toInt(parentId);
      if (pid >= 0 && findPerson(pid)) addRef(p.parent, pid);
    }
  }

  if (children !== undefined && Array.isArray(children)) {
    const wanted = new Set<number>(children.map(toInt));
    for (const q of persons) {
      if (toInt(q.id) === id) continue;
      if (validIds(q.parent).includes(id) && !wanted.has(toInt(q.id))) removeRef(q.parent, id);
    }
    for (const childId of children) {
      const cid = toInt(childId);
      const child = findPerson(cid);
      if (cid >= 0 && child) addRef(child.parent, id);
    }
  }

  rebuildChildrenIndex();
  saveData();
  res.json(toPerson(p));
});

app.delete('/api/persons/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const p = findPerson(id);
  if (!p) return res.status(404).json({ error: 'Person not found' });

  for (const q of persons) {
    if (toInt(q.id) === id) continue;
    removeRef(q.parent, id);
  }
  const idx = persons.findIndex(x => toInt(x.id) === id);
  if (idx >= 0) persons.splice(idx, 1);
  rebuildChildrenIndex();
  saveData();
  res.json({ success: true });
});

app.get('/api/graph', (_req, res) => {
  const ancestorIds = new Set<number>();
  const nodes = persons
    .slice()
    .sort((a, b) => toInt(a.id) - toInt(b.id))
    .map(p => {
      const id = toInt(p.id);
      const hasParents = validIds(p.parent).length > 0;
      const hasChildren = (childrenIndex.get(id) || []).length > 0;

      let type: string;
      if (!hasParents && hasChildren) {
        type = 'ancestor';
        ancestorIds.add(id);
      } else if (hasChildren) {
        type = 'core';
      } else {
        type = 'person';
      }

      if (p['great_person'] && p['great_person'] !== '') { type = 'great_person'; ancestorIds.add(id); }
      if (p['famous'] && p['famous'] !== '') { type = 'famous'; ancestorIds.add(id); }

      return {
        id: id.toString(),
        label: p.name || '',
        type,
        size: type === 'ancestor' || type === 'great_person' ? 18 : type === 'famous' ? 16 : type === 'core' ? 16 : 14,
        community: id < 100 ? 1 : 2,
        '籍贯': p['籍贯'] || '',
        birth_date: p.birth_date || '',
        dead_date: p.dead_date || '',
      };
    });

  const seen = new Set<string>();
  const links: any[] = [];
  for (const p of persons) {
    const targetId = toInt(p.id);
    if (!findPerson(targetId)) continue;
    for (const pid of validIds(p.parent)) {
      if (!findPerson(pid)) continue;
      const key = `${pid}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        source: pid.toString(),
        target: targetId.toString(),
        value: 7,
        label: 'parent of',
        ancestorLink: ancestorIds.has(pid) || ancestorIds.has(targetId),
      });
    }
  }

  res.json({ nodes, links });
});

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: path.dirname(DATA_PATH), windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

let syncing = false;

app.post('/api/sync', async (_req, res) => {
  if (syncing) return res.status(409).json({ success: false, message: '同步正在进行中，请稍候' });
  syncing = true;
  try {
    await runGit(['add', 'du.json']);
    const status = await runGit(['status', '--porcelain', '--', 'du.json']);
    let committed = false;
    if (status.trim()) {
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      await runGit(['commit', '-m', `sync: update du.json at ${stamp}`]);
      committed = true;
    }
    await runGit(['push', 'origin', 'main']);
    res.json({ success: true, message: committed ? '已同步到 Gitee' : '数据无变化，已是最新' });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message || '同步失败' });
  } finally {
    syncing = false;
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  console.log(`Data source: ${DATA_PATH} (${persons.length} persons)`);
  console.log(`API: http://0.0.0.0:${PORT}/api/persons`);
  console.log(`Graph: http://0.0.0.0:${PORT}/api/graph`);
});

process.on('SIGINT', () => {
  process.exit(0);
});
