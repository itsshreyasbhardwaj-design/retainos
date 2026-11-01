import { type Db } from "@retainos/database";
import { newId } from "@retainos/shared";

/**
 * Feedback clustering by term overlap.
 *
 * Deliberately simple and fully local: no embedding model, no API call, no
 * dependency. It groups feedback that shares distinctive terms, which is enough
 * to surface "eleven people are describing the same problem". Every cluster is
 * editable by a human, because a grouping is a suggestion.
 */

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "doing",
  "have", "has", "had", "having", "i", "you", "he", "she", "it", "we", "they", "me", "him",
  "her", "us", "them", "my", "your", "his", "its", "our", "their", "to", "of", "in", "on",
  "at", "by", "for", "with", "about", "into", "from", "up", "down", "out", "over", "under",
  "again", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "too", "very", "can", "will", "just", "should", "would", "could", "get",
  "got", "please", "thanks", "thank", "hi", "hello", "also", "really", "very", "much",
  "want", "need", "like", "make", "made", "use", "used", "using", "app", "page",
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length >= 3 && t.length <= 30 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

export interface ClusterInput {
  id: string;
  title: string;
  body: string;
}

export interface Cluster {
  label: string;
  keywords: string[];
  itemIds: string[];
  /** Mean pairwise similarity within the cluster, as a coherence signal. */
  cohesion: number;
}

/** Jaccard similarity over term sets. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Single-link agglomerative clustering with a similarity floor.
 * O(n²) in the number of items, which is fine for a feedback inbox; the caller
 * caps how many items are passed in.
 */
export function clusterFeedback(
  items: ClusterInput[],
  opts: { threshold?: number; minClusterSize?: number } = {},
): Cluster[] {
  const threshold = opts.threshold ?? 0.22;
  const minSize = opts.minClusterSize ?? 2;
  const termSets = items.map((i) => new Set(tokenise(`${i.title} ${i.title} ${i.body}`)));

  // Union-find over items linked by sufficient similarity.
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const sims = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = similarity(termSets[i]!, termSets[j]!);
      if (s > 0) sims.set(`${i}:${j}`, s);
      if (s >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    // Keywords: terms appearing in the most members, ties broken by length so
    // the label prefers the more specific word.
    const counts = new Map<string, number>();
    for (const m of members) for (const t of termSets[m]!) counts.set(t, (counts.get(t) ?? 0) + 1);
    const keywords = [...counts.entries()]
      .filter(([, n]) => n >= Math.max(2, Math.ceil(members.length * 0.4)))
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 5)
      .map(([t]) => t);

    let total = 0;
    let pairs = 0;
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const i = Math.min(members[x]!, members[y]!);
        const j = Math.max(members[x]!, members[y]!);
        total += sims.get(`${i}:${j}`) ?? 0;
        pairs++;
      }
    }

    clusters.push({
      label: keywords.length > 0 ? keywords.slice(0, 3).join(", ") : "Ungrouped feedback",
      keywords,
      itemIds: members.map((m) => items[m]!.id),
      cohesion: pairs === 0 ? 0 : total / pairs,
    });
  }

  return clusters.sort((a, b) => b.itemIds.length - a.itemIds.length);
}

/** Recompute and persist clusters for a project's open feedback. */
export function rebuildClusters(
  db: Db,
  ids: { orgId: string; projectId: string },
  opts: { limit?: number; threshold?: number } = {},
  now = Date.now(),
): { clusters: number; itemsGrouped: number } {
  const items = db.all<{ id: string; title: string; body: string }>(
    `SELECT id, title, body FROM feedback_items
      WHERE project_id = ? AND deleted_at IS NULL AND status NOT IN ('closed','duplicate')
      ORDER BY created_at DESC LIMIT ?`,
    [ids.projectId, Math.min(opts.limit ?? 500, 2000)],
  );
  const clusters = clusterFeedback(items, { threshold: opts.threshold });

  return db.tx(() => {
    // Clusters a human has edited are preserved; only machine-generated ones
    // are replaced, so a founder's curation is never silently overwritten.
    db.run("UPDATE feedback_items SET cluster_id = NULL WHERE project_id = ? AND cluster_id IN (SELECT id FROM feedback_clusters WHERE project_id = ? AND edited_by_human = 0)",
      [ids.projectId, ids.projectId]);
    db.run("DELETE FROM feedback_clusters WHERE project_id = ? AND edited_by_human = 0", [ids.projectId]);

    let grouped = 0;
    for (const c of clusters) {
      const id = newId("fcl");
      db.run(
        `INSERT INTO feedback_clusters (id, org_id, project_id, label, keywords, item_count, method, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'term_overlap', ?, ?)`,
        [id, ids.orgId, ids.projectId, c.label, JSON.stringify(c.keywords), c.itemIds.length, now, now],
      );
      for (const itemId of c.itemIds) {
        db.run("UPDATE feedback_items SET cluster_id = ? WHERE id = ? AND project_id = ? AND cluster_id IS NULL",
          [id, itemId, ids.projectId]);
        grouped++;
      }
    }
    return { clusters: clusters.length, itemsGrouped: grouped };
  });
}

export function listClusters(db: Db, projectId: string) {
  return db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM feedback_items f WHERE f.cluster_id = c.id) AS live_count
       FROM feedback_clusters c WHERE c.project_id = ? ORDER BY live_count DESC`,
    [projectId],
  );
}

/** Candidate duplicates for a single item, for the inbox's merge suggestion. */
export function duplicateCandidates(
  db: Db,
  projectId: string,
  itemId: string,
  opts: { threshold?: number; limit?: number } = {},
) {
  const target = db.get<{ id: string; title: string; body: string }>(
    "SELECT id, title, body FROM feedback_items WHERE id = ? AND project_id = ?", [itemId, projectId],
  );
  if (!target) return [];
  const others = db.all<{ id: string; title: string; body: string; status: string; vote_count: number }>(
    `SELECT id, title, body, status, vote_count FROM feedback_items
      WHERE project_id = ? AND id != ? AND deleted_at IS NULL AND status != 'duplicate'
      ORDER BY created_at DESC LIMIT 500`,
    [projectId, itemId],
  );
  const targetTerms = new Set(tokenise(`${target.title} ${target.title} ${target.body}`));
  return others
    .map((o) => ({
      ...o,
      similarity: similarity(targetTerms, new Set(tokenise(`${o.title} ${o.title} ${o.body}`))),
    }))
    .filter((o) => o.similarity >= (opts.threshold ?? 0.3))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.limit ?? 5);
}
