export type Capability =
  | 'tasks:read' | 'tasks:write' | 'calendar:read' | 'notes:read' | 'notes:write'
  | 'drive:read' | 'music:read' | 'music:control' | 'github:read'
  | 'projects:read' | 'projects:write'
  | 'users:manage';

export type Role = 'admin' | 'member' | 'guest';

export interface Me {
  auth: boolean;
  user: { id: string; name: string; role: Role };
  caps: Capability[];
  via?: string;
  timezone: string | null;
  connected: Record<'google' | 'spotify' | 'github' | 'linear', boolean>;
  configured: Record<'google' | 'spotify' | 'linear' | 'github', boolean>;
}

export interface ApiError extends Error {
  status?: number;
}

export type Priority = 'low' | 'med' | 'high';

export interface CalEvent {
  id: string;
  title: string;
  notes: string;
  start: string;
  end: string;
  allDay: boolean;
  link: string;
  location: string;
  task: boolean;
  done: boolean;
  priority: Priority | null;
  project: string | null;
  // Tasks only: the Linear issue this task created, when it was filed under a project.
  linearUrl?: string | null;
  linearKey?: string | null;
  completedAt?: string | null;
  // Set when the task saved but its Linear side did not.
  warning?: string | null;
}

export interface LinearTeam { id: string; name: string; }

export type LinearStatusType = 'backlog' | 'planned' | 'started' | 'paused' | 'completed' | 'canceled';
export interface LinearProjectStatus { id: string; name: string; type: LinearStatusType; color: string; }

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string | null;
  url: string;
  progress: number;
  targetDate: string | null;
  startDate: string | null;
  createdAt: string;
  archivedAt: string | null;
  status: LinearProjectStatus;
  lead: { name: string } | null;
  stats?: { total: number; done: number };
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface NoteMeta {
  // Path relative to the notes root, e.g. "proj/ideas.md"; flat notes have folder "".
  name: string;
  folder: string;
  modified: number;
  tags: string[];
  // Present only when the note has checkbox tasks (`- [ ]` / `- [x]`).
  tasks?: { open: number; done: number };
  // Only on searches (?q=): text around the first body hit.
  snippet?: string;
}

export interface NoteDoc {
  name: string;
  body: string;
  tags: string[];
  // Paths of the notes that link here with [[...]].
  backlinks: string[];
}

/** @deprecated use NoteDoc */
export type NoteBody = NoteDoc;

export interface NotifySettings {
  enabled: boolean;
  // "HH:MM" local time, or null when the daily digest is off.
  digestAt: string | null;
  // Minutes before a timed event/task that the reminder fires (5..120).
  leadMin: number;
}

export interface AppNotification {
  id: string;
  key: string;
  kind: 'reminder' | 'digest';
  title: string;
  body: string;
  at: string;
  read: boolean;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  folder: boolean;
}

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  image: string;
  ms: number;
}

export interface SpotifyPlaylist {
  id: string;
  uri: string;
  name: string;
  owner: string;
  mine: boolean | null;
  collaborative: boolean;
  tracks: number;
  image: string;
}

export interface Passkey {
  id: string;
  label: string;
  createdAt: number;
  lastUsed: number | null;
}

export interface AccessUser {
  id: string;
  name: string;
  role: Role;
  permissions: Capability[] | null;
  caps: Capability[];
  macs: string[];
  disabled: boolean;
  hasPassword: boolean;
  passkeys: Passkey[];
  createdAt: number;
  lastSeen: number | null;
  sessions: { sid: string; via: string; ip: string; createdAt: number }[];
}

export interface AuditEntry {
  at: number;
  event: string;
  name?: string;
  by?: string;
  provider?: string;
  via?: string;
  ip?: string;
}

export interface AccessData {
  capabilities: Record<Capability, string>;
  roles: Record<Role, Capability[]>;
  users: AccessUser[];
  audit: AuditEntry[];
}

export type ViewName =
  | 'today' | 'inbox' | 'tasks' | 'calendar' | 'notes' | 'drive' | 'music' | 'github' | 'account' | 'access';

export interface InboxItem {
  kind: 'task' | 'issue' | 'pr';
  id: string;
  key?: string; // Linear identifier, issues only
  title: string;
  url: string | null;
  due: string | null;
  priority: Priority | null;
  source: 'google' | 'linear' | 'github';
  meta: string;
  score: number;
}

export interface SearchResults {
  tasks: { id: string; title: string; start: string | null; done: boolean }[];
  notes: { name: string; snippet: string }[];
  files: { id: string; name: string; webViewLink?: string; folder: boolean }[];
  repos: { name: string; url: string }[];
  prs: { title: string; url: string; repo: string }[];
}

export interface NotificationsPayload {
  settings: NotifySettings;
  unread: number;
  items: AppNotification[];
}

// Result of the quick-capture parser (GET /api/quick/parse).
export interface QuickParsed {
  title: string;
  due: string | null; // YYYY-MM-DD or YYYY-MM-DDTHH:MM
  hasTime: boolean;
  priority: Priority | null;
  project: { id: string; name: string } | null;
  duration: number | null; // minutes
  warnings: string[];
}
