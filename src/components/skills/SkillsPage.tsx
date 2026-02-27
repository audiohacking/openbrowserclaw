// ---------------------------------------------------------------------------
// OpenBrowserClaw — Skills page
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import { Plus, X, Trash2, Zap, ExternalLink, RefreshCw, FolderGit2 } from 'lucide-react';
import { getAllSkills, saveSkill, deleteSkill } from '../../db.js';
import type { Skill } from '../../types.js';
import { ulid } from '../../ulid.js';

const SKILLS_INDEX_URL = 'https://github.com/anthropics/skills';
const MAX_DESCRIPTION_PREVIEW = 200;
/** Separator inserted between concatenated Markdown documents (rules, SKILL+rules). */
const CONTENT_SEPARATOR = '\n\n---\n\n';
/** Directory names that are not skill directories and should be skipped during repo discovery. */
const EXCLUDED_ROOT_DIRS = new Set(['packages', 'node_modules', 'dist', '.github', 'spec', 'template']);

// ---------------------------------------------------------------------------
// GitHub URL parsing
// ---------------------------------------------------------------------------

type GitHubUrlInfo =
  | { type: 'repo'; owner: string; repo: string; branch: string; repoUrl: string }
  | { type: 'dir'; owner: string; repo: string; branch: string; path: string; repoUrl: string }
  | { type: 'file'; owner: string; repo: string; branch: string; path: string; repoUrl: string }
  | { type: 'raw'; rawUrl: string }
  | null;

function parseGitHubUrl(url: string): GitHubUrlInfo {
  const trimmed = url.trim().replace(/\/$/, '');

  if (trimmed.startsWith('https://raw.githubusercontent.com/')) {
    return { type: 'raw', rawUrl: trimmed };
  }

  // /blob/branch/path → file
  const fileMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/,
  );
  if (fileMatch) {
    const [, owner, repo, branch, path] = fileMatch;
    return { type: 'file', owner, repo, branch, path, repoUrl: `https://github.com/${owner}/${repo}` };
  }

  // /tree/branch/path → directory
  const dirMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/,
  );
  if (dirMatch) {
    const [, owner, repo, branch, path] = dirMatch;
    return { type: 'dir', owner, repo, branch, path, repoUrl: `https://github.com/${owner}/${repo}` };
  }

  // /owner/repo → repo root
  const repoMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    return { type: 'repo', owner, repo, branch: 'main', repoUrl: `https://github.com/${owner}/${repo}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// GitHub API / raw content helpers
// ---------------------------------------------------------------------------

type GitHubEntry = {
  name: string;
  type: 'file' | 'dir';
  path: string;
  download_url: string | null;
};

async function ghListDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<GitHubEntry[]> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github.v3+json' } });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Path not found: ${path || '/'}`);
    if (res.status === 403) throw new Error('GitHub API rate limit hit — try again in a minute');
    throw new Error(`GitHub API error ${res.status}`);
  }
  return res.json();
}

async function ghFetchRaw(
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  return res.text();
}

/**
 * Compile all non-template rule files from a `rules/` directory into a single document.
 * Used as a fallback when no pre-compiled AGENTS.md exists.
 */
async function fetchAndCompileRules(
  owner: string,
  repo: string,
  rulesPath: string,
  branch: string,
): Promise<string> {
  const entries = await ghListDir(owner, repo, rulesPath, branch);
  const ruleFiles = entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (ruleFiles.length === 0) return '';
  const contents = await Promise.all(
    ruleFiles.map((f) => ghFetchRaw(owner, repo, f.path, branch)),
  );
  return contents.join(CONTENT_SEPARATOR);
}

// ---------------------------------------------------------------------------
// SKILL.md parsing helpers
// ---------------------------------------------------------------------------

/** Extract name + description from YAML frontmatter (if present), else from Markdown heading. */
function parseSkillMetadata(
  text: string,
  fallback: string,
): { name: string; description: string } {
  // Try YAML frontmatter first
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (nameMatch) {
      return {
        name: nameMatch[1].trim().replace(/^['"]|['"]$/, ''),
        description: descMatch
          ? descMatch[1].trim().replace(/^['"]|['"]$/, '').slice(0, MAX_DESCRIPTION_PREVIEW)
          : '',
      };
    }
  }

  // Fall back to first Markdown heading
  const headingMatch = text.match(/^#\s+(.+)$/m);
  const name = headingMatch ? headingMatch[1].trim() : fallback;

  const bodyAfterHeading = text.replace(/^#\s+.+$/m, '').replace(/^---[\s\S]*?---\r?\n/, '').trim();
  const firstPara = bodyAfterHeading.split(/\n\n+/)[0]?.trim() ?? '';
  const description = firstPara.replace(/^#+\s*/, '').slice(0, MAX_DESCRIPTION_PREVIEW);

  return { name, description };
}

// ---------------------------------------------------------------------------
// Skill candidate (before saving)
// ---------------------------------------------------------------------------

interface SkillCandidate {
  name: string;
  description: string;
  content: string;
  repoUrl: string;
  repoBranch: string;
  repoPath: string;     // path to dir or file in repo
  sourceUrl: string;    // human-readable GitHub URL
  isFile: boolean;
}

/**
 * Import a single skill from a directory, following the agentskills.io spec:
 *  - SKILL.md  → metadata (name, description from YAML frontmatter) + overview
 *  - AGENTS.md → compiled full guide for AI agents; used as the injected content
 *  - rules/    → individual rule files compiled as a fallback when no AGENTS.md exists
 *
 * The content priority for injection is: AGENTS.md > compiled rules/ > SKILL.md
 */
async function importSkillDir(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  repoUrl: string,
): Promise<SkillCandidate> {
  const entries = await ghListDir(owner, repo, path, branch);
  const fileNames = entries.filter((e) => e.type === 'file').map((e) => e.name.toLowerCase());
  const hasRulesDir = entries.some((e) => e.type === 'dir' && e.name === 'rules');

  const hasSkillMd = fileNames.includes('skill.md');
  const hasAgentsMd = fileNames.includes('agents.md');

  if (!hasSkillMd && !hasAgentsMd) {
    throw new Error(`No SKILL.md or AGENTS.md found in ${path}`);
  }

  // SKILL.md = skill definition: YAML frontmatter provides name/description metadata
  let skillMdContent = '';
  if (hasSkillMd) {
    skillMdContent = await ghFetchRaw(owner, repo, `${path}/SKILL.md`, branch);
  }

  // AGENTS.md = compiled full guide generated from all rule files; preferred for injection
  let agentsMdContent = '';
  if (hasAgentsMd) {
    agentsMdContent = await ghFetchRaw(owner, repo, `${path}/AGENTS.md`, branch);
  }

  // When no pre-compiled AGENTS.md exists but a rules/ directory does, compile the rules
  let rulesContent = '';
  if (!hasAgentsMd && hasRulesDir) {
    try {
      rulesContent = await fetchAndCompileRules(owner, repo, `${path}/rules`, branch);
    } catch (err) {
      console.debug(`Could not compile rules from ${path}/rules:`, err);
    }
  }

  // Content priority for injection into the system prompt:
  //   1. AGENTS.md (pre-compiled full guide — most complete)
  //   2. SKILL.md + compiled rules/ (if no AGENTS.md but rules exist)
  //   3. SKILL.md alone (simple single-file skill)
  let content: string;
  if (agentsMdContent) {
    content = agentsMdContent;
  } else if (rulesContent) {
    content = skillMdContent ? `${skillMdContent}${CONTENT_SEPARATOR}${rulesContent}` : rulesContent;
  } else {
    content = skillMdContent;
  }

  const fallbackName = path.split('/').filter(Boolean).pop() ?? 'Imported Skill';
  // Always prefer SKILL.md for metadata; fall back to AGENTS.md if no SKILL.md
  const { name, description } = parseSkillMetadata(skillMdContent || agentsMdContent, fallbackName);

  return {
    name,
    description,
    content,
    repoUrl,
    repoBranch: branch,
    repoPath: path,
    sourceUrl: `${repoUrl}/tree/${branch}/${path}`,
    isFile: false,
  };
}

/**
 * Discover all skill directories inside a repo.
 *
 * Per spec: first reads the repo-root AGENTS.md (when it exists) to understand
 * the repo's structure and available skills.  Then enumerates skill directories
 * under `skills/` (standard location), falling back to the repo root.
 *
 * Returns the root AGENTS.md content (as a repo guide) alongside the candidates.
 */
async function discoverRepoSkills(
  owner: string,
  repo: string,
  branch: string,
  repoUrl: string,
): Promise<{ repoGuide: string; candidates: SkillCandidate[] }> {
  // Read root AGENTS.md first — it describes the repo structure and available skills
  let repoGuide = '';
  try {
    repoGuide = await ghFetchRaw(owner, repo, 'AGENTS.md', branch);
  } catch {
    // No root AGENTS.md — proceed without it
  }

  let dirs: GitHubEntry[] = [];

  // Try /skills/ first (standard convention per agentskills.io spec)
  try {
    const entries = await ghListDir(owner, repo, 'skills', branch);
    dirs = entries.filter((e) => e.type === 'dir');
  } catch {
    // Fall back to repo root, skip hidden and known non-skill directories
    const entries = await ghListDir(owner, repo, '', branch);
    dirs = entries.filter(
      (e) => e.type === 'dir' && !e.name.startsWith('.') && !EXCLUDED_ROOT_DIRS.has(e.name),
    );
  }

  if (dirs.length === 0) throw new Error('No skill directories found in this repository');

  const candidates: SkillCandidate[] = [];
  for (const dir of dirs) {
    try {
      const candidate = await importSkillDir(owner, repo, branch, dir.path, repoUrl);
      candidates.push(candidate);
    } catch (err) {
      // Skip directories that don't contain SKILL.md or AGENTS.md
      console.debug(`Skipping ${dir.path}:`, err);
    }
  }

  if (candidates.length === 0) {
    throw new Error('No skills found — no SKILL.md or AGENTS.md in any directory');
  }

  return { repoGuide, candidates };
}

/**
 * Re-fetch a skill from its stored source (simulates git pull for a single skill).
 * Follows the same content-priority logic as importSkillDir.
 */
async function syncSkillContent(skill: Skill): Promise<string> {
  const { repoUrl, repoBranch = 'main', repoPath } = skill;
  if (!repoUrl || !repoPath) throw new Error('No repo metadata — cannot sync');

  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) throw new Error('Unrecognised repo URL format');
  const [, owner, repo] = m;

  // Determine if the stored path is a single file or a directory
  const isFilePath = skill.isFile ?? repoPath.toLowerCase().endsWith('.md');

  if (isFilePath) {
    return ghFetchRaw(owner, repo, repoPath, repoBranch);
  }

  const candidate = await importSkillDir(owner, repo, repoBranch, repoPath, repoUrl);
  return candidate.content;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ImportMode = 'url' | 'manual' | 'preview';

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<Record<string, string>>({});

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('url');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

  // Manual edit state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [pendingCandidate, setPendingCandidate] = useState<SkillCandidate | null>(null);

  // Repo preview (multiple candidates)
  const [previewCandidates, setPreviewCandidates] = useState<SkillCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [repoGuide, setRepoGuide] = useState(''); // root AGENTS.md content when present

  const loadSkills = useCallback(async () => {
    setLoading(true);
    const all = await getAllSkills();
    setSkills(all);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  function resetForm() {
    setImportUrl('');
    setImportError('');
    setImportMode('url');
    setName('');
    setDescription('');
    setContent('');
    setPendingCandidate(null);
    setPreviewCandidates([]);
    setSelectedCandidates(new Set());
    setRepoGuide('');
    setShowForm(false);
  }

  async function handleFetch() {
    setImportError('');
    const url = importUrl.trim();
    if (!url) return;

    setImporting(true);
    try {
      const parsed = parseGitHubUrl(url);

      if (!parsed) {
        // Treat as a plain URL → fetch raw
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const text = await res.text();
        const lastSegment = url.split('/').filter(Boolean).pop() ?? 'Imported Skill';
        const { name: n, description: d } = parseSkillMetadata(text, lastSegment);
        setName(n);
        setDescription(d);
        setContent(text);
        setPendingCandidate({
          name: n, description: d, content: text,
          repoUrl: '', repoBranch: 'main', repoPath: '',
          sourceUrl: url, isFile: true,
        });
        setImportMode('manual');
        return;
      }

      if (parsed.type === 'raw') {
        const res = await fetch(parsed.rawUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const text = await res.text();
        const lastSegment = parsed.rawUrl.split('/').filter(Boolean).pop() ?? 'Imported Skill';
        const { name: n, description: d } = parseSkillMetadata(text, lastSegment);
        setName(n); setDescription(d); setContent(text);
        setPendingCandidate({
          name: n, description: d, content: text,
          repoUrl: '', repoBranch: 'main', repoPath: '',
          sourceUrl: parsed.rawUrl, isFile: true,
        });
        setImportMode('manual');
        return;
      }

      if (parsed.type === 'file') {
        const text = await ghFetchRaw(parsed.owner, parsed.repo, parsed.path, parsed.branch);
        const fallback = parsed.path.split('/').filter(Boolean).pop() ?? 'Imported Skill';
        const { name: n, description: d } = parseSkillMetadata(text, fallback);
        setName(n); setDescription(d); setContent(text);
        const candidate: SkillCandidate = {
          name: n, description: d, content: text,
          repoUrl: parsed.repoUrl, repoBranch: parsed.branch,
          repoPath: parsed.path, sourceUrl: url, isFile: true,
        };
        setPendingCandidate(candidate);
        setImportMode('manual');
        return;
      }

      if (parsed.type === 'dir') {
        const candidate = await importSkillDir(
          parsed.owner, parsed.repo, parsed.branch, parsed.path, parsed.repoUrl,
        );
        setName(candidate.name); setDescription(candidate.description); setContent(candidate.content);
        setPendingCandidate(candidate);
        setImportMode('manual');
        return;
      }

      if (parsed.type === 'repo') {
        // Try main branch first, then master (both are common defaults)
        let repoGuideResult = '';
        let candidates: SkillCandidate[] = [];
        let mainErr: unknown;
        try {
          const result = await discoverRepoSkills(
            parsed.owner, parsed.repo, 'main', parsed.repoUrl,
          );
          repoGuideResult = result.repoGuide;
          candidates = result.candidates;
        } catch (err) {
          mainErr = err;
          try {
            const result = await discoverRepoSkills(
              parsed.owner, parsed.repo, 'master', parsed.repoUrl,
            );
            repoGuideResult = result.repoGuide;
            candidates = result.candidates;
          } catch (masterErr) {
            throw new Error(
              `Could not discover skills on 'main' (${mainErr instanceof Error ? mainErr.message : mainErr}) ` +
              `or 'master' (${masterErr instanceof Error ? masterErr.message : masterErr}) branches`,
            );
          }
        }
        setRepoGuide(repoGuideResult);
        setPreviewCandidates(candidates);
        setSelectedCandidates(new Set(candidates.map((c) => c.repoPath)));
        setImportMode('preview');
        return;
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveSingle() {
    const candidate = pendingCandidate;
    const skill: Skill = {
      id: ulid(),
      name: name.trim(),
      description: description.trim(),
      content: content.trim(),
      enabled: true,
      sourceUrl: (candidate?.sourceUrl || importUrl.trim()) || undefined,
      repoUrl: candidate?.repoUrl || undefined,
      repoBranch: candidate?.repoBranch || undefined,
      repoPath: candidate?.repoPath || undefined,
      isFile: candidate?.isFile,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSkill(skill);
    resetForm();
    loadSkills();
  }

  async function handleSaveFromPreview() {
    const toSave = previewCandidates.filter((c) => selectedCandidates.has(c.repoPath));
    for (const c of toSave) {
      await saveSkill({
        id: ulid(),
        name: c.name,
        description: c.description,
        content: c.content,
        enabled: true,
        sourceUrl: c.sourceUrl,
        repoUrl: c.repoUrl,
        repoBranch: c.repoBranch,
        repoPath: c.repoPath,
        isFile: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    resetForm();
    loadSkills();
  }

  async function handleToggle(skill: Skill) {
    await saveSkill({ ...skill, enabled: !skill.enabled, updatedAt: Date.now() });
    loadSkills();
  }

  async function handleDelete(id: string) {
    await deleteSkill(id);
    setDeleteConfirm(null);
    loadSkills();
  }

  async function handleSync(skill: Skill) {
    setSyncing(skill.id);
    setSyncError((prev) => { const n = { ...prev }; delete n[skill.id]; return n; });
    try {
      const newContent = await syncSkillContent(skill);
      await saveSkill({ ...skill, content: newContent, updatedAt: Date.now() });
      loadSkills();
    } catch (err) {
      setSyncError((prev) => ({
        ...prev,
        [skill.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSyncing(null);
    }
  }

  const isSyncable = (s: Skill) => !!(s.repoUrl && s.repoPath);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Agent Skills</h2>
        <div className="flex gap-2">
          <a
            href={SKILLS_INDEX_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-sm gap-1.5"
            title="Browse public skills index"
          >
            <ExternalLink className="w-4 h-4" />
            <span className="hidden sm:inline">Browse Index</span>
          </a>
          <button
            className="btn btn-primary btn-sm gap-1.5"
            onClick={() => { setShowForm(!showForm); if (showForm) resetForm(); }}
          >
            {showForm ? <><X className="w-4 h-4" /> Cancel</> : <><Plus className="w-4 h-4" /> Add Skill</>}
          </button>
        </div>
      </div>

      <p className="text-sm opacity-60 mb-4">
        Skills extend the assistant with domain-specific knowledge via SKILL.md files.
        Active skills are injected into the system prompt on every conversation.
        Skills with a GitHub source can be synced to stay up to date.
      </p>

      {/* Add / Import form */}
      {showForm && (
        <div className="card card-bordered bg-base-200 mb-6">
          <div className="card-body p-4 sm:p-6 gap-4">

            {/* URL import mode */}
            {importMode === 'url' && (
              <>
                <h3 className="card-title text-base">Import Skill</h3>
                <div className="form-control">
                  <label className="label">
                    <span className="label-text">GitHub URL or raw content URL</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      className="input input-bordered input-sm flex-1 font-mono"
                      placeholder="https://github.com/ClickHouse/agent-skills"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleFetch(); }}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleFetch}
                      disabled={importing || !importUrl.trim()}
                    >
                      {importing
                        ? <span className="loading loading-spinner loading-xs" />
                        : <FolderGit2 className="w-4 h-4" />}
                      {importing ? 'Fetching…' : 'Fetch'}
                    </button>
                  </div>
                  {importError && <p className="text-error text-xs mt-1">{importError}</p>}
                  <div className="text-xs opacity-50 mt-2 space-y-0.5">
                    <p>Supports:</p>
                    <p className="pl-2">• Repo root — <span className="font-mono">github.com/owner/repo</span> (imports all skills)</p>
                    <p className="pl-2">• Skill dir — <span className="font-mono">github.com/owner/repo/tree/main/skills/name</span></p>
                    <p className="pl-2">• SKILL.md file — <span className="font-mono">github.com/owner/repo/blob/main/…/SKILL.md</span></p>
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm self-start"
                  onClick={() => setImportMode('manual')}
                >
                  Or paste content manually
                </button>
              </>
            )}

            {/* Manual edit / single preview mode */}
            {importMode === 'manual' && (
              <>
                <h3 className="card-title text-base">
                  {pendingCandidate ? 'Review & Save' : 'Add Skill Manually'}
                </h3>
                <div className="form-control">
                  <label className="label"><span className="label-text">Name</span></label>
                  <input
                    type="text"
                    className="input input-bordered input-sm"
                    placeholder="My Skill"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="form-control">
                  <label className="label">
                    <span className="label-text">Description <span className="opacity-50">(optional)</span></span>
                  </label>
                  <input
                    type="text"
                    className="input input-bordered input-sm"
                    placeholder="Short description of what this skill does"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="form-control">
                  <label className="label"><span className="label-text">SKILL.md Content</span></label>
                  <textarea
                    className="textarea textarea-bordered font-mono text-xs h-48"
                    placeholder="Paste the contents of a SKILL.md file here…"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                  />
                  <p className="text-xs opacity-40 mt-1">
                    {content.length.toLocaleString()} characters
                  </p>
                </div>
                <div className="card-actions justify-between">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setPendingCandidate(null); setImportMode('url'); }}
                  >
                    ← Back
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!name.trim() || !content.trim()}
                    onClick={handleSaveSingle}
                  >
                    Save Skill
                  </button>
                </div>
              </>
            )}

            {/* Repo preview — multiple skills */}
            {importMode === 'preview' && (
              <>
                <h3 className="card-title text-base">
                  Found {previewCandidates.length} skill{previewCandidates.length !== 1 ? 's' : ''}
                </h3>

                {/* Root AGENTS.md — repo guide read per spec to understand what's offered */}
                {repoGuide && (
                  <details className="collapse collapse-arrow border border-base-300 bg-base-100 rounded-box">
                    <summary className="collapse-title text-sm font-medium py-2 min-h-0">
                      Repo guide (AGENTS.md)
                    </summary>
                    <div className="collapse-content">
                      <pre className="text-xs font-mono whitespace-pre-wrap opacity-70 max-h-48 overflow-y-auto">
                        {repoGuide}
                      </pre>
                    </div>
                  </details>
                )}

                <p className="text-sm opacity-60">
                  Select which skills to import. Each can be synced individually later.
                </p>
                <div className="space-y-2">
                  {previewCandidates.map((c) => (
                    <label key={c.repoPath} className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm mt-0.5"
                        checked={selectedCandidates.has(c.repoPath)}
                        onChange={(e) => {
                          setSelectedCandidates((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.repoPath);
                            else next.delete(c.repoPath);
                            return next;
                          });
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{c.name}</p>
                        {c.description && (
                          <p className="text-xs opacity-60 line-clamp-2">{c.description}</p>
                        )}
                        <p className="text-xs opacity-40">{c.content.length.toLocaleString()} chars</p>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="card-actions justify-between">
                  <button className="btn btn-ghost btn-sm" onClick={() => setImportMode('url')}>
                    ← Back
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={selectedCandidates.size === 0}
                    onClick={handleSaveFromPreview}
                  >
                    Import {selectedCandidates.size} skill{selectedCandidates.size !== 1 ? 's' : ''}
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      )}

      {/* Skills list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : skills.length === 0 ? (
        <div className="hero py-12">
          <div className="hero-content text-center">
            <div>
              <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No skills installed</p>
              <p className="text-xs opacity-60 mt-1">Add a skill to extend the assistant's capabilities</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className={`card card-bordered bg-base-200 ${!skill.enabled ? 'opacity-50' : ''}`}
            >
              <div className="card-body p-4 sm:p-6 gap-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">{skill.name}</p>
                    {skill.description && (
                      <p className="text-sm opacity-70 mt-0.5">{skill.description}</p>
                    )}
                    {skill.sourceUrl && (
                      <a
                        href={skill.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs opacity-40 hover:opacity-70 flex items-center gap-1 mt-1 w-fit"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {skill.sourceUrl.replace(/^https?:\/\//, '')}
                      </a>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xs opacity-40">{skill.content.length.toLocaleString()} chars</p>
                      {skill.updatedAt > skill.createdAt && (
                        <p className="text-xs opacity-40">
                          · synced {new Date(skill.updatedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    {syncError[skill.id] && (
                      <p className="text-error text-xs mt-1">{syncError[skill.id]}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isSyncable(skill) && (
                      <button
                        className="btn btn-ghost btn-xs"
                        title="Sync from source"
                        onClick={() => handleSync(skill)}
                        disabled={syncing === skill.id}
                      >
                        {syncing === skill.id
                          ? <span className="loading loading-spinner loading-xs" />
                          : <RefreshCw className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    <input
                      type="checkbox"
                      className="toggle toggle-primary toggle-sm"
                      checked={skill.enabled}
                      onChange={() => handleToggle(skill)}
                    />
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => setDeleteConfirm(skill.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg">Remove skill?</h3>
            <p className="py-4">This skill will be permanently removed.</p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="btn btn-error" onClick={() => handleDelete(deleteConfirm)}>Remove</button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setDeleteConfirm(null)}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
}
