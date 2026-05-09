import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, PrivateState, RoomState, ServerToClientEvents } from "../shared/types";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const socketUrl =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : window.location.origin);

export function App() {
  const [socket, setSocket] = useState<GameSocket>();
  const [name, setName] = useState(localStorage.getItem("cheese:name") ?? "");
  const [code, setCode] = useState(localStorage.getItem("cheese:code") ?? "");
  const [room, setRoom] = useState<RoomState>();
  const [me, setMe] = useState<PrivateState>();
  const [message, setMessage] = useState("");
  const [selectedAccomplices, setSelectedAccomplices] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [soundEnabled, setSoundEnabled] = useState(localStorage.getItem("cheese:sound") !== "off");
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  useEffect(() => {
    const nextSocket: GameSocket = io(socketUrl, { autoConnect: true });
    nextSocket.on("roomState", setRoom);
    nextSocket.on("privateState", setMe);
    nextSocket.on("error", setMessage);
    nextSocket.on("actionRequired", setMessage);
    setSocket(nextSocket);
    return () => {
      nextSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!soundEnabled || !audioUnlocked || room?.phase !== "night" || !room.currentHour) return;
    speakHour(room.currentHour);
  }, [audioUnlocked, room?.currentHour, room?.phase, soundEnabled]);

  const self = useMemo(() => room?.players.find((player) => player.id === me?.playerId), [room, me]);
  const isHost = Boolean(self?.isHost);

  function createRoom() {
    if (!socket) return;
    unlockAudio();
    socket.emit("createRoom", { name }, (response) => {
      if (!response.ok) return setMessage(response.error);
      localStorage.setItem("cheese:name", name.trim());
      localStorage.setItem("cheese:code", response.room.code);
      setRoom(response.room);
      setMe(response.privateState);
      setCode(response.room.code);
      setMessage("房间创建好了。");
    });
  }

  function joinRoom() {
    if (!socket) return;
    unlockAudio();
    socket.emit("joinRoom", { name, code }, (response) => {
      if (!response.ok) return setMessage(response.error);
      localStorage.setItem("cheese:name", name.trim());
      localStorage.setItem("cheese:code", response.room.code);
      setRoom(response.room);
      setMe(response.privateState);
      setCode(response.room.code);
      setMessage("已加入房间。");
    });
  }

  function emit<K extends keyof ClientToServerEvents>(
    event: K,
    payload: Parameters<ClientToServerEvents[K]>[0]
  ) {
    if (!socket || !room) return;
    (socket.emit as (eventName: string, eventPayload: unknown) => void)(event, payload);
  }

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem("cheese:sound", next ? "on" : "off");
    if (next) {
      unlockAudio();
      speak("声音已开启");
    }
  }

  function unlockAudio() {
    setAudioUnlocked(true);
  }

  if (!room || !me) {
    return (
      <main className="app shell">
        <section className="join-panel">
          <div>
            <p className="eyebrow">Cheese Thief</p>
            <h1>奶酪大盗</h1>
            <p className="intro">输入昵称开房，或用房间码加入一场狡猾的夜晚。</p>
          </div>
          <label>
            昵称
            <input value={name} maxLength={12} onChange={(event) => setName(event.target.value)} placeholder="小灰" />
          </label>
          <label>
            房间码
            <input
              value={code}
              maxLength={4}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCD"
            />
          </label>
          <div className="button-row">
            <button className="primary" disabled={!name.trim()} onClick={createRoom}>
              创建房间
            </button>
            <button disabled={!name.trim() || !code.trim()} onClick={joinRoom}>
              加入
            </button>
          </div>
          {message && <p className="toast">{message}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">房间 {room.code}</p>
          <h1>奶酪大盗</h1>
        </div>
        <div className="top-actions">
          <button className="icon-button" title={soundEnabled ? "关闭声音" : "开启声音"} onClick={toggleSound}>
            {soundEnabled ? "声" : "静"}
          </button>
          <span className={`phase phase-${room.phase}`}>{phaseName(room.phase)}</span>
        </div>
      </header>

      {message && <p className="toast">{message}</p>}

      <section className="private-card">
        <div>
          <p className="eyebrow">你的秘密</p>
          <h2>{secretTitle(me)}</h2>
        </div>
        <div className="dice">{me.dice ? `${me.dice} 点` : "待开局"}</div>
      </section>

      {room.phase === "lobby" && (
        <section className="panel">
          <h2>等待玩家</h2>
          <PlayerList room={room} />
          {isHost && (
            <button className="primary full" disabled={room.players.length < 4} onClick={() => emit("startGame", { code: room.code })}>
              开始游戏
            </button>
          )}
          <p className="hint">需要 4-8 人。创建房间的人是房主。</p>
        </section>
      )}

      {room.phase === "night" && (
        <section className="panel night">
          <div className="clock">{room.currentHour} 点</div>
          <p className="countdown">{formatRemaining(me.hourEndsAt, now)}</p>
          <h2>{me.isAwake ? "你醒来了" : "闭眼等待"}</h2>
          {me.isAwake && (
            <div className="awake-info">
              <p className="cheese-state">{me.visibleCheesePresent ? "奶酪还在桌上。" : "奶酪已经不见了。"}</p>
              <p>同一时间醒来的玩家：{me.awakePlayerNames.join("、")}</p>
              {currentPersonalLog(me)?.thiefWitnessedName && (
                <p className="danger">你看见 {currentPersonalLog(me)?.thiefWitnessedName} 偷走了奶酪。</p>
              )}
            </div>
          )}
          {me.canInspect && (
            <div className="action-box">
              <p>此刻只有你醒来，可以查看一名玩家的骰点。</p>
              <div className="grid-buttons">
                {me.inspectOptions.map((player) => (
                  <button key={player.id} onClick={() => emit("chooseInspectTarget", { code: room.code, targetId: player.id })}>
                    {player.name}
                  </button>
                ))}
              </div>
              <button className="ghost full" onClick={() => emit("skipInspect", { code: room.code })}>
                跳过查看
              </button>
            </div>
          )}
        </section>
      )}

      {room.phase === "accomplice" && (
        <section className="panel">
          <h2>{me.canChooseAccomplice ? "选择共犯" : "等待大盗选择共犯"}</h2>
          {me.canChooseAccomplice && (
            <>
              <p className="hint">需要选择 {room.requiredAccomplices} 名玩家。</p>
              <div className="grid-buttons">
                {me.accompliceOptions.map((player) => {
                  const active = selectedAccomplices.includes(player.id);
                  return (
                    <button
                      className={active ? "selected" : ""}
                      key={player.id}
                      onClick={() => setSelectedAccomplices(toggleSelection(selectedAccomplices, player.id, room.requiredAccomplices))}
                    >
                      {player.name}
                    </button>
                  );
                })}
              </div>
              <button
                className="primary full"
                disabled={selectedAccomplices.length !== room.requiredAccomplices}
                onClick={() => emit("chooseAccomplice", { code: room.code, targetIds: selectedAccomplices })}
              >
                确认共犯
              </button>
            </>
          )}
        </section>
      )}

      {room.phase === "discussion" && (
        <section className="panel">
          <h2>天亮讨论</h2>
          <NightLog me={me} />
          <InspectNotes me={me} />
        </section>
      )}

      {room.phase === "discussion" && isHost && (
        <section className="panel">
          <h2>房主操作</h2>
          <button className="primary full" onClick={() => emit("beginVoting", { code: room.code })}>
            进入投票
          </button>
          <button className="full" onClick={() => emit("restartGame", { code: room.code })}>
            重新开局
          </button>
        </section>
      )}

      {room.phase === "voting" && (
        <section className="panel">
          <h2>{me.canVote ? "投出你怀疑的大盗" : "等待其他玩家投票"}</h2>
          <div className="grid-buttons">
            {room.players.map((player) => (
              <button key={player.id} disabled={!me.canVote} onClick={() => emit("submitVote", { code: room.code, targetId: player.id })}>
                {player.name}{player.hasVoted ? " ✓" : ""}
              </button>
            ))}
          </div>
        </section>
      )}

      {room.phase === "result" && room.result && (
        <section className="panel result">
          <h2>{room.result.winner === "mice" ? "普通老鼠获胜" : "大盗阵营获胜"}</h2>
          <p>{room.result.reason}</p>
          <p>真正的奶酪大盗是 {room.result.thiefName}。</p>
          {isHost && (
            <button className="primary full" onClick={() => emit("restartGame", { code: room.code })}>
              返回大厅
            </button>
          )}
        </section>
      )}

      {room.phase !== "lobby" && (
        <section className="panel compact">
          <h2>玩家</h2>
          <PlayerList room={room} />
        </section>
      )}
    </main>
  );
}

function PlayerList({ room }: { room: RoomState }) {
  return (
    <ul className="players">
      {room.players.map((player) => (
        <li key={player.id}>
          <span>{player.name}</span>
          <small>
            {player.isHost ? "房主" : ""} {player.connected ? "在线" : "离线"}
          </small>
        </li>
      ))}
    </ul>
  );
}

function NightLog({ me }: { me: PrivateState }) {
  if (me.personalNightLog.length === 0) {
    return <p className="hint">你整晚没有醒来，没有可公开确认的夜晚观察。</p>;
  }
  return (
    <div className="timeline">
      {me.personalNightLog.map((entry) => (
        <p key={entry.hour}>
          {entry.hour} 点你醒来，同醒玩家：{entry.awakePlayerNames.join("、")}。奶酪
          {entry.cheesePresentAtStart ? "还在" : "已不在"}
          {entry.cheeseStolen && entry.thiefWitnessedName ? `，你看见 ${entry.thiefWitnessedName} 偷走了奶酪` : ""}。
        </p>
      ))}
    </div>
  );
}

function InspectNotes({ me }: { me: PrivateState }) {
  if (me.inspectResults.length === 0) return <p className="hint">你没有查看过其他玩家的骰点。</p>;
  return (
    <div className="notes">
      {me.inspectResults.map((result) => (
        <p key={`${result.hour}-${result.targetId}`}>
          {result.hour} 点你查看了 {result.targetName}：{result.dice} 点。
        </p>
      ))}
    </div>
  );
}

function secretTitle(me: PrivateState): string {
  if (!me.role) return "身份未揭晓";
  if (me.role === "thief") return "你是奶酪大盗";
  if (me.isAccomplice) return "你是共犯";
  return "你是普通小老鼠";
}

function phaseName(phase: RoomState["phase"]): string {
  const names: Record<RoomState["phase"], string> = {
    lobby: "大厅",
    night: "夜晚",
    accomplice: "共犯",
    discussion: "讨论",
    voting: "投票",
    result: "结算"
  };
  return names[phase];
}

function currentPersonalLog(me: PrivateState) {
  return me.personalNightLog.find((entry) => entry.hour === me.dice);
}

function formatRemaining(endsAt: number | undefined, now: number): string {
  if (!endsAt) return "等待下一次钟声";
  return `${Math.max(0, Math.ceil((endsAt - now) / 1000))} 秒后进入下一点`;
}

function speakHour(hour: number) {
  speak(`${hour}点了`);
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.95;
  utterance.pitch = 1.05;
  window.speechSynthesis.speak(utterance);
}

function toggleSelection(current: string[], id: string, limit: number): string[] {
  if (current.includes(id)) return current.filter((item) => item !== id);
  if (current.length >= limit) return [...current.slice(1), id];
  return [...current, id];
}
