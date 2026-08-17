import type { Session, SessionId } from "../types";

export class SessionRegistry {
  private sessions = new Map<SessionId, Session>();
  private counter = 0;
  private active: SessionId | undefined;

  add(s: Omit<Session, "id">): Session {
    const id = `s${++this.counter}`;
    const session: Session = { ...s, id };
    this.sessions.set(id, session);
    if (this.active === undefined) this.active = id;
    return session;
  }

  get(id?: SessionId): Session | undefined {
    const key = id ?? this.active;
    return key === undefined ? undefined : this.sessions.get(key);
  }

  has(id: SessionId): boolean {
    return this.sessions.has(id);
  }

  setActive(id: SessionId): boolean {
    if (!this.sessions.has(id)) return false;
    this.active = id;
    return true;
  }

  activeId(): SessionId | undefined {
    return this.active;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  remove(id: SessionId): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.sessions.delete(id);
    if (this.active === id) {
      this.active = this.sessions.keys().next().value as SessionId | undefined;
    }
    return s;
  }

  removeAll(): Session[] {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.active = undefined;
    return all;
  }
}
