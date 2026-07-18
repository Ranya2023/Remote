import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

// This is the page people land on after scanning the presenter's "Audience"
// QR code (see the audienceUrl / QRCodeSVG block in Present.tsx). It is
// deliberately a *different* route than /remote: scanning it only lets
// someone vote/ask/react, never control slides. It rides the same
// `session_${sessionId}` Supabase realtime channel Present.tsx and
// MobileRemote.tsx already use, but - importantly - never calls
// `channel.track()`, so joining here does not inflate the presenter's
// "N remotes connected" controller count.

interface PollOption { id: string; text: string; votes: number; }
interface PollState {
  id: string;
  question: string;
  options: PollOption[];
  isQuiz: boolean;
  correctOptionId?: string;
  status: 'live' | 'closed';
  createdAt: number;
}
interface AudienceQuestion { id: string; text: string; upvotes: number; answered: boolean; createdAt: number; }
type FeedbackKind = '👍' | '❤️' | '👏' | '🤔' | '🐢' | '🚀';
type FeedbackCounts = Record<FeedbackKind, number>;
const EMPTY_FEEDBACK: FeedbackCounts = { '👍': 0, '❤️': 0, '👏': 0, '🤔': 0, '🐢': 0, '🚀': 0 };
interface AudienceState {
  joinCount: number;
  polls: PollState[];
  questions: AudienceQuestion[];
  feedback: FeedbackCounts;
  qnaOpen: boolean;
}
const DEFAULT_AUDIENCE_STATE: AudienceState = { joinCount: 0, polls: [], questions: [], feedback: EMPTY_FEEDBACK, qnaOpen: true };

const FEEDBACK_OPTIONS: FeedbackKind[] = ['👍', '❤️', '👏', '🤔', '🐢', '🚀'];

export default function AudienceJoin() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [audienceState, setAudienceState] = useState<AudienceState>(DEFAULT_AUDIENCE_STATE);
  const audienceStateRef = useRef<AudienceState>(DEFAULT_AUDIENCE_STATE);
  useEffect(() => { audienceStateRef.current = audienceState; }, [audienceState]);

  const [tab, setTab] = useState<'poll' | 'qna' | 'feedback'>('poll');
  const channelRef = useRef<any>(null);

  const [questionDraft, setQuestionDraft] = useState('');
  const [questionSent, setQuestionSent] = useState(false);
  const [recentFeedback, setRecentFeedback] = useState<FeedbackKind | null>(null);

  // Local "have I already voted / upvoted" memory, scoped per session so it
  // survives a refresh but doesn't leak across different presentations.
  // This is a client-side courtesy, not real anti-fraud - someone could
  // clear storage and vote again, same tradeoff MobileRemote.tsx's PIN
  // already accepts for control access.
  const storageKey = sessionId ? `nextslide_audience_${sessionId}` : null;
  const [myVotes, setMyVotes] = useState<Record<string, string>>({}); // pollId -> optionId
  const [myUpvotes, setMyUpvotes] = useState<Record<string, true>>({}); // questionId -> true

  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (saved.votes) setMyVotes(saved.votes);
      if (saved.upvotes) setMyUpvotes(saved.upvotes);
    } catch { /* noop */ }
  }, [storageKey]);

  const saveLocal = (votes: Record<string, string>, upvotes: Record<string, true>) => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ votes, upvotes })); } catch { /* noop */ }
  };

  useEffect(() => {
    const match = window.location.href.match(/[?&]session=([^&]+)/);
    const session = match ? match[1].trim().replace(/[/#\s]+$/, '') : null;
    if (!session) return;
    setSessionId(session);

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const fetchInitialState = async () => {
      const { data } = await supabase.from('sessions').select('audience_state').eq('id', session).single();
      if (data?.audience_state && !cancelled) {
        audienceStateRef.current = data.audience_state as AudienceState;
        setAudienceState(data.audience_state as AudienceState);
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
        fetchInitialState();
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      // No `presence` config here on purpose - see the top-of-file note.
      const channel = supabase.channel(`session_${session}`, { config: { broadcast: { ack: true } } });

      channel.on('broadcast', { event: 'audience_state_update' }, (payload: any) => {
        const next = payload.payload?.audienceState as AudienceState | undefined;
        if (next) { audienceStateRef.current = next; setAudienceState(next); }
      });

      channel.subscribe(async (status: string) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          reconnectAttempt = 0;
          setConnected(true);
          // Friendly join counter for the presenter's sidebar. Fires once per
          // page load/reconnect - a simple "people scanned in" signal, not a
          // precise unique-visitor count.
          channel.send({ type: 'broadcast', event: 'audience_join', payload: {} });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false);
          scheduleReconnect();
        }
      });

      channelRef.current = channel;
    };

    fetchInitialState();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
    };
  }, []);

  const livePoll = audienceState.polls.find((p) => p.status === 'live');
  const lastClosedQuizIVotedOn = useMemo(() => {
    if (livePoll) return null;
    const closedQuizzes = audienceState.polls.filter((p) => p.status === 'closed' && p.isQuiz && myVotes[p.id]);
    return closedQuizzes.length ? closedQuizzes[closedQuizzes.length - 1] : null;
  }, [audienceState.polls, livePoll, myVotes]);

  const castVote = (poll: PollState, optionId: string) => {
    if (myVotes[poll.id]) return;
    const nextVotes = { ...myVotes, [poll.id]: optionId };
    setMyVotes(nextVotes);
    saveLocal(nextVotes, myUpvotes);
    channelRef.current?.send({ type: 'broadcast', event: 'audience_vote', payload: { pollId: poll.id, optionId } });
  };

  const submitQuestion = () => {
    const text = questionDraft.trim();
    if (!text || !audienceState.qnaOpen) return;
    channelRef.current?.send({ type: 'broadcast', event: 'audience_question', payload: { text } });
    setQuestionDraft('');
    setQuestionSent(true);
    setTimeout(() => setQuestionSent(false), 2500);
  };

  const upvote = (q: AudienceQuestion) => {
    if (myUpvotes[q.id]) return;
    const nextUpvotes = { ...myUpvotes, [q.id]: true as const };
    setMyUpvotes(nextUpvotes);
    saveLocal(myVotes, nextUpvotes);
    channelRef.current?.send({ type: 'broadcast', event: 'audience_upvote', payload: { questionId: q.id } });
  };

  const sendFeedback = (kind: FeedbackKind) => {
    channelRef.current?.send({ type: 'broadcast', event: 'audience_feedback', payload: { kind } });
    setRecentFeedback(kind);
    setTimeout(() => setRecentFeedback((k) => (k === kind ? null : k)), 900);
  };

  if (!sessionId) {
    return (
      <div className="flex h-screen w-full bg-gray-950 text-white items-center justify-center px-6 text-center">
        <p className="text-gray-400 text-sm">
          This link is missing a session. Ask the presenter for the QR code or link shown on their screen.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-gray-950 text-white">
      <div className="px-4 pt-5 pb-3 border-b border-gray-800 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold">NextSlide</h1>
          <p className="text-[11px] text-gray-500 font-mono">Session {sessionId}</p>
        </div>
        <span className={`text-[11px] px-2 py-1 rounded-full ${connected ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
          {connected ? '● Live' : 'Connecting…'}
        </span>
      </div>

      <div className="flex gap-1 mx-4 mt-3 bg-gray-900 rounded-lg p-1 shrink-0">
        {(['poll', 'qna', 'feedback'] as const).map((tKey) => (
          <button
            key={tKey}
            onClick={() => setTab(tKey)}
            className={`flex-1 text-sm py-2 rounded-md capitalize font-medium ${tab === tKey ? 'bg-emerald-600' : 'text-gray-400'}`}
          >
            {tKey === 'poll' ? '🗳️ Poll' : tKey === 'qna' ? '❓ Q&A' : '💬 React'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === 'poll' && (
          <>
            {livePoll ? (
              <PollCard poll={livePoll} myVote={myVotes[livePoll.id]} onVote={(optId) => castVote(livePoll, optId)} />
            ) : lastClosedQuizIVotedOn ? (
              <QuizReveal poll={lastClosedQuizIVotedOn} myVote={myVotes[lastClosedQuizIVotedOn.id]} />
            ) : (
              <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-gray-500">
                <span className="text-4xl">🗳️</span>
                <p className="text-sm">No live poll right now.</p>
                <p className="text-xs">The presenter's next poll will pop up here automatically.</p>
              </div>
            )}
          </>
        )}

        {tab === 'qna' && (
          <div className="flex flex-col gap-4">
            {audienceState.qnaOpen ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={questionDraft}
                  onChange={(e) => setQuestionDraft(e.target.value)}
                  placeholder="Ask an anonymous question..."
                  maxLength={280}
                  rows={3}
                  className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm resize-none"
                />
                <button
                  onClick={submitQuestion}
                  disabled={!questionDraft.trim()}
                  className="bg-emerald-600 disabled:opacity-30 rounded-lg py-2.5 text-sm font-semibold"
                >
                  {questionSent ? '✓ Sent!' : 'Send question'}
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 text-center py-2">Questions are closed right now.</p>
            )}

            <div className="flex flex-col gap-2">
              {[...audienceState.questions]
                .sort((a, b) => (b.upvotes - a.upvotes) || (b.createdAt - a.createdAt))
                .map((q) => (
                  <div key={q.id} className={`rounded-lg p-3 border text-sm ${q.answered ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-900 border-gray-800'}`}>
                    <p className="mb-2">{q.text}{q.answered && <span className="ml-2 text-[10px] text-emerald-500">✓ answered</span>}</p>
                    <button
                      onClick={() => upvote(q)}
                      disabled={!!myUpvotes[q.id]}
                      className={`text-xs px-2.5 py-1 rounded-full border ${myUpvotes[q.id] ? 'border-emerald-600 text-emerald-500' : 'border-gray-700 text-gray-400'}`}
                    >
                      👍 {q.upvotes}
                    </button>
                  </div>
                ))}
              {audienceState.questions.length === 0 && (
                <p className="text-xs text-gray-600 text-center py-6">No questions yet - be the first.</p>
              )}
            </div>
          </div>
        )}

        {tab === 'feedback' && (
          <div className="grid grid-cols-3 gap-3">
            {FEEDBACK_OPTIONS.map((kind) => (
              <button
                key={kind}
                onClick={() => sendFeedback(kind)}
                className={`rounded-xl py-6 text-3xl bg-gray-900 border transition-transform ${recentFeedback === kind ? 'border-emerald-500 scale-110' : 'border-gray-800'}`}
              >
                {kind}
              </button>
            ))}
            <p className="col-span-3 text-center text-xs text-gray-600 mt-1">Tap to send a quick reaction to the presenter, live.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PollCard({ poll, myVote, onVote }: { poll: PollState; myVote?: string; onVote: (optionId: string) => void }) {
  const totalVotes = poll.options.reduce((s, o) => s + o.votes, 0);
  const voted = !!myVote;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base font-semibold">{poll.isQuiz ? '❓ ' : ''}{poll.question}</p>
      <div className="flex flex-col gap-2">
        {poll.options.map((opt) => {
          const pct = totalVotes ? Math.round((opt.votes / totalVotes) * 100) : 0;
          const isMine = myVote === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => onVote(opt.id)}
              disabled={voted}
              className={`relative overflow-hidden text-left rounded-lg border px-4 py-3 text-sm ${isMine ? 'border-emerald-500' : 'border-gray-800'} ${voted ? '' : 'active:scale-[0.98]'}`}
            >
              {voted && (
                <div className="absolute inset-0 bg-emerald-900/40 transition-all duration-500" style={{ width: `${pct}%` }} />
              )}
              <div className="relative flex justify-between">
                <span>{opt.text}{isMine ? ' ✓' : ''}</span>
                {voted && <span className="text-gray-400">{pct}%</span>}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-500 text-center">
        {voted ? `Thanks for voting - ${totalVotes} vote${totalVotes === 1 ? '' : 's'} so far.` : 'Tap an option to vote.'}
      </p>
    </div>
  );
}

function QuizReveal({ poll, myVote }: { poll: PollState; myVote?: string }) {
  const correct = poll.correctOptionId === myVote;
  return (
    <div className={`rounded-xl p-5 border text-center flex flex-col items-center gap-2 ${correct ? 'border-emerald-600 bg-emerald-950/40' : 'border-red-700 bg-red-950/30'}`}>
      <span className="text-3xl">{correct ? '✅' : '❌'}</span>
      <p className="font-semibold">{correct ? 'Correct!' : 'Not quite'}</p>
      <p className="text-xs text-gray-400">{poll.question}</p>
      {!correct && (
        <p className="text-xs text-gray-300">
          Correct answer: {poll.options.find((o) => o.id === poll.correctOptionId)?.text}
        </p>
      )}
    </div>
  );
}
