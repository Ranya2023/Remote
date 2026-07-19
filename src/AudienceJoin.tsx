import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

// This is the page people land on after scanning the presenter's "Audience"
// QR code (see the audienceUrl / QRCodeSVG block in Present.tsx). It is
// deliberately a *different* route than /remote: scanning it only lets
// someone join the quiz/vote/ask/react, never control slides. It rides the
// same `session_${sessionId}` Supabase realtime channel Present.tsx and
// MobileRemote.tsx already use, but - importantly - never calls
// `channel.track()`, so joining here does not inflate the presenter's
// "N remotes connected" controller count.

// --- Quiz types - MUST stay byte-for-byte in sync with Present.tsx, since
// this is all one JSON shape round-tripping through Supabase + broadcast.
interface QuizOption { id: string; text: string; imageUrl?: string; }
interface QuizQuestion {
  id: string;
  question: string;
  options: QuizOption[];
  correctOptionId: string;
  source?: string;
  timeLimitSeconds: number;
}
interface QuizAnswerRecord { optionId: string; answeredAt: number; correct: boolean; points: number; }
interface QuizParticipant {
  id: string;
  name: string;
  joinedAt: number;
  totalScore: number;
  answers: Record<string, QuizAnswerRecord>;
}
type QuizStatus = 'building' | 'lobby' | 'question' | 'reveal' | 'finished';
interface QuizState {
  questions: QuizQuestion[];
  currentIndex: number;
  status: QuizStatus;
  questionStartedAt: number | null;
  participants: Record<string, QuizParticipant>;
}
const DEFAULT_QUIZ_STATE: QuizState = { questions: [], currentIndex: -1, status: 'building', questionStartedAt: null, participants: {} };

interface AudienceQuestion { id: string; text: string; upvotes: number; answered: boolean; createdAt: number; }
type FeedbackKind = '👍' | '❤️' | '👏' | '🤔' | '🐢' | '🚀';
type FeedbackCounts = Record<FeedbackKind, number>;
const EMPTY_FEEDBACK: FeedbackCounts = { '👍': 0, '❤️': 0, '👏': 0, '🤔': 0, '🐢': 0, '🚀': 0 };
interface AudienceState {
  joinCount: number;
  quiz: QuizState;
  questions: AudienceQuestion[];
  feedback: FeedbackCounts;
  qnaOpen: boolean;
}
const DEFAULT_AUDIENCE_STATE: AudienceState = { joinCount: 0, quiz: DEFAULT_QUIZ_STATE, questions: [], feedback: EMPTY_FEEDBACK, qnaOpen: true };

const FEEDBACK_OPTIONS: FeedbackKind[] = ['👍', '❤️', '👏', '🤔', '🐢', '🚀'];

// --- Kurdish (default) / English text -------------------------------------
type Lang = 'ku' | 'en';
const TXT: Record<Lang, Record<string, string>> = {
  ku: {
    live: 'ئۆنلاین', connecting: 'پەیوەندی...', quiz: 'کویز', qna: 'پرسیار', react: 'ڕیاکشن',
    yourName: 'ناوت چیە؟', namePlaceholder: 'ناوت بنووسە...', join: 'بەشداریکردن',
    waitingStart: 'چاوەڕێی دەستپێکردنی کویزەکە بکە...', youAreIn: 'بەشداربوویت وەک',
    noQuiz: 'هیچ کویزێکی ئۆنلاین نییە', noQuizSub: 'کاتێک وانابەخێر کویزێک دەستپێبکات، لێرە دەردەکەوێت.',
    question: 'پرسیار', timeLeft: 'کاتی ماوە', answerLocked: 'وەڵامەکەت نێردرا! چاوەڕێی ئەنجامەکان بکە...',
    correct: 'ڕاستە! ✅', incorrect: 'هەڵەیە ❌', points: 'خاڵ', correctAnswer: 'وەڵامی ڕاست',
    source: 'سەرچاوە بۆ خوێندنەوە', yourRank: 'پلەی تۆ', leaderboard: 'پێشەنگەکان',
    quizFinished: 'کویزەکە تەواو بوو 🎉', downloadResults: 'داگرتنی ئەنجامەکان',
    askQuestion: 'پرسیارێکی نەناسراو بکە...', sendQuestion: 'ناردنی پرسیار', sent: 'نێردرا! ✓',
    questionsClosed: 'پرسیارکردن داخراوە.', noQuestionsYet: 'هێشتا پرسیار نییە - یەکەم کەس بە.',
    answered: 'وەڵامدراوە', tapReact: 'کرتە بکە بۆ ناردنی ڕیاکشنێکی خێرا بۆ وانابەخێر.',
    switchLang: 'English', missingSession: 'ئەم لینکە سیشنی تێدا نییە. داوای کۆدی QR یان لینک لە وانابەخێر بکە.',
  },
  en: {
    live: 'Live', connecting: 'Connecting…', quiz: '🧠 Quiz', qna: '❓ Q&A', react: '💬 React',
    yourName: "What's your name?", namePlaceholder: 'Enter your name...', join: 'Join',
    waitingStart: 'Waiting for the quiz to start...', youAreIn: "You're in as",
    noQuiz: 'No live quiz right now', noQuizSub: "The presenter's next quiz will pop up here automatically.",
    question: 'Question', timeLeft: 'Time left', answerLocked: 'Answer locked in! Waiting for results...',
    correct: 'Correct! ✅', incorrect: 'Not quite ❌', points: 'points', correctAnswer: 'Correct answer',
    source: 'Source / further reading', yourRank: 'Your rank', leaderboard: 'Leaderboard',
    quizFinished: 'Quiz finished 🎉', downloadResults: '⬇ Download results',
    askQuestion: 'Ask an anonymous question...', sendQuestion: 'Send question', sent: 'Sent! ✓',
    questionsClosed: 'Questions are closed right now.', noQuestionsYet: 'No questions yet - be the first.',
    answered: 'answered', tapReact: 'Tap to send a quick reaction to the presenter, live.',
    switchLang: 'کوردی', missingSession: 'This link is missing a session. Ask the presenter for the QR code or link shown on their screen.',
  },
};

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function AudienceJoin() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [audienceState, setAudienceState] = useState<AudienceState>(DEFAULT_AUDIENCE_STATE);
  const audienceStateRef = useRef<AudienceState>(DEFAULT_AUDIENCE_STATE);
  useEffect(() => { audienceStateRef.current = audienceState; }, [audienceState]);

  const [lang, setLang] = useState<Lang>('ku');
  const t = TXT[lang];

  const [tab, setTab] = useState<'quiz' | 'qna' | 'feedback'>('quiz');
  const channelRef = useRef<any>(null);

  const [questionDraft, setQuestionDraft] = useState('');
  const [questionSent, setQuestionSent] = useState(false);
  const [recentFeedback, setRecentFeedback] = useState<FeedbackKind | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  // Local persistence: which quiz participant am I, and my Q&A upvotes -
  // scoped per session so it survives a refresh but doesn't leak across
  // different presentations. Client-side courtesy, not real anti-fraud.
  const storageKey = sessionId ? `nextslide_audience_${sessionId}` : null;
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [myUpvotes, setMyUpvotes] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (saved.participantId) setParticipantId(saved.participantId);
      if (saved.upvotes) setMyUpvotes(saved.upvotes);
      if (saved.lang) setLang(saved.lang);
    } catch { /* noop */ }
  }, [storageKey]);

  const saveLocal = (next: { participantId?: string | null; upvotes?: Record<string, true>; lang?: Lang }) => {
    if (!storageKey) return;
    try {
      const prev = JSON.parse(localStorage.getItem(storageKey) || '{}');
      localStorage.setItem(storageKey, JSON.stringify({ ...prev, ...next }));
    } catch { /* noop */ }
  };

  const switchLang = () => {
    const next = lang === 'ku' ? 'en' : 'ku';
    setLang(next);
    saveLocal({ lang: next });
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

  const quiz = audienceState.quiz;
  const me = participantId ? quiz.participants[participantId] : undefined;
  const currentQuestion = quiz.currentIndex >= 0 ? quiz.questions[quiz.currentIndex] : null;
  const myAnswerForCurrent = currentQuestion && me ? me.answers[currentQuestion.id] : undefined;
  const leaderboard = useMemo(() => Object.values(quiz.participants).sort((a, b) => b.totalScore - a.totalScore), [quiz.participants]);
  const myRank = me ? leaderboard.findIndex((p) => p.id === me.id) + 1 : 0;

  const joinQuiz = () => {
    const name = nameDraft.trim();
    if (!name) return;
    const id = participantId || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    setParticipantId(id);
    saveLocal({ participantId: id });
    channelRef.current?.send({ type: 'broadcast', event: 'quiz_join', payload: { participantId: id, name } });
  };

  const answerQuestion = (optionId: string) => {
    if (!participantId || !currentQuestion || myAnswerForCurrent) return;
    channelRef.current?.send({
      type: 'broadcast', event: 'quiz_answer',
      payload: { participantId, questionId: currentQuestion.id, optionId, answeredAt: Date.now() },
    });
  };

  const downloadMyResults = () => {
    const rows: (string | number)[][] = [['Rank', 'Name', 'Score', 'Correct answers', 'Total questions']];
    leaderboard.forEach((p, i) => {
      const correctCount = Object.values(p.answers).filter((a) => a.correct).length;
      rows.push([i + 1, p.name + (p.id === participantId ? ' (you)' : ''), p.totalScore, correctCount, quiz.questions.length]);
    });
    rows.push([]);
    rows.push(['Question', 'Source / further reading']);
    quiz.questions.forEach((q) => rows.push([q.question, q.source || '']));
    downloadCsv(`quiz-results-${sessionId}.csv`, rows);
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
    saveLocal({ upvotes: nextUpvotes });
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
        <p className="text-gray-400 text-sm">{t.missingSession}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-gray-950 text-white" style={{ direction: lang === 'ku' ? 'rtl' : 'ltr' }}>
      <div className="px-4 pt-5 pb-3 border-b border-gray-800 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold">NextSlide</h1>
          <p className="text-[11px] text-gray-500 font-mono" style={{ direction: 'ltr' }}>Session {sessionId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={switchLang} className="text-[11px] bg-gray-800 px-2.5 py-1 rounded-full font-bold">{t.switchLang}</button>
          <span className={`text-[11px] px-2 py-1 rounded-full ${connected ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            {connected ? `● ${t.live}` : t.connecting}
          </span>
        </div>
      </div>

      <div className="flex gap-1 mx-4 mt-3 bg-gray-900 rounded-lg p-1 shrink-0">
        {(['quiz', 'qna', 'feedback'] as const).map((tKey) => (
          <button
            key={tKey}
            onClick={() => setTab(tKey)}
            className={`flex-1 text-sm py-2 rounded-md font-medium ${tab === tKey ? 'bg-emerald-600' : 'text-gray-400'}`}
          >
            {tKey === 'quiz' ? `🧠 ${t.quiz}` : tKey === 'qna' ? t.qna : t.react}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === 'quiz' && (
          <QuizTab
            quiz={quiz}
            t={t}
            me={me}
            currentQuestion={currentQuestion}
            myAnswer={myAnswerForCurrent}
            leaderboard={leaderboard}
            myRank={myRank}
            nameDraft={nameDraft}
            setNameDraft={setNameDraft}
            onJoin={joinQuiz}
            onAnswer={answerQuestion}
            onDownload={downloadMyResults}
          />
        )}

        {tab === 'qna' && (
          <div className="flex flex-col gap-4">
            {audienceState.qnaOpen ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={questionDraft}
                  onChange={(e) => setQuestionDraft(e.target.value)}
                  placeholder={t.askQuestion}
                  maxLength={280}
                  rows={3}
                  className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm resize-none"
                />
                <button
                  onClick={submitQuestion}
                  disabled={!questionDraft.trim()}
                  className="bg-emerald-600 disabled:opacity-30 rounded-lg py-2.5 text-sm font-semibold"
                >
                  {questionSent ? t.sent : t.sendQuestion}
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 text-center py-2">{t.questionsClosed}</p>
            )}

            <div className="flex flex-col gap-2">
              {[...audienceState.questions]
                .sort((a, b) => (b.upvotes - a.upvotes) || (b.createdAt - a.createdAt))
                .map((q) => (
                  <div key={q.id} className={`rounded-lg p-3 border text-sm ${q.answered ? 'bg-gray-900/40 border-gray-800 text-gray-500' : 'bg-gray-900 border-gray-800'}`}>
                    <p className="mb-2">{q.text}{q.answered && <span className="ml-2 text-[10px] text-emerald-500">✓ {t.answered}</span>}</p>
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
                <p className="text-xs text-gray-600 text-center py-6">{t.noQuestionsYet}</p>
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
            <p className="col-span-3 text-center text-xs text-gray-600 mt-1">{t.tapReact}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function QuizTab({ quiz, t, me, currentQuestion, myAnswer, leaderboard, myRank, nameDraft, setNameDraft, onJoin, onAnswer, onDownload }: {
  quiz: QuizState; t: Record<string, string>; me?: QuizParticipant; currentQuestion: QuizQuestion | null;
  myAnswer?: QuizAnswerRecord; leaderboard: QuizParticipant[]; myRank: number;
  nameDraft: string; setNameDraft: (v: string) => void; onJoin: () => void; onAnswer: (optionId: string) => void; onDownload: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (quiz.status !== 'question') return;
    const i = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(i);
  }, [quiz.status]);

  if (quiz.status === 'building') {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-gray-500">
        <span className="text-4xl">🧠</span>
        <p className="text-sm">{t.noQuiz}</p>
        <p className="text-xs">{t.noQuizSub}</p>
      </div>
    );
  }

  if (quiz.status === 'lobby') {
    if (!me) {
      return (
        <div className="flex flex-col items-center justify-center text-center gap-4 py-12">
          <span className="text-4xl">🧠</span>
          <p className="font-semibold">{t.yourName}</p>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={t.namePlaceholder}
            maxLength={30}
            className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-center text-sm w-full max-w-xs"
          />
          <button
            onClick={onJoin}
            disabled={!nameDraft.trim()}
            className="bg-emerald-600 disabled:opacity-30 rounded-full px-8 py-2.5 text-sm font-bold w-full max-w-xs"
          >
            {t.join}
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-gray-400">
        <span className="text-4xl animate-pulse">⏳</span>
        <p className="text-sm">{t.youAreIn} <span className="text-white font-semibold">{me.name}</span></p>
        <p className="text-xs">{t.waitingStart}</p>
      </div>
    );
  }

  if ((quiz.status === 'question' || quiz.status === 'reveal') && currentQuestion) {
    const secondsLeft = quiz.questionStartedAt
      ? Math.max(0, Math.ceil((quiz.questionStartedAt + currentQuestion.timeLimitSeconds * 1000 - Date.now()) / 1000))
      : currentQuestion.timeLimitSeconds;
    const palette = ['bg-red-600', 'bg-blue-600', 'bg-amber-500', 'bg-emerald-600', 'bg-purple-600', 'bg-pink-600'];

    if (quiz.status === 'question') {
      return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>{t.question} {quiz.currentIndex + 1}/{quiz.questions.length}</span>
            <span className="font-mono font-bold text-base text-white">{secondsLeft}s</span>
          </div>
          <p className="text-base font-semibold text-center">{currentQuestion.question}</p>

          {myAnswer ? (
            <div className="flex flex-col items-center gap-2 py-8 text-gray-400">
              <span className="text-3xl">📨</span>
              <p className="text-sm text-center">{t.answerLocked}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {currentQuestion.options.map((opt, i) => (
                <button
                  key={opt.id}
                  onClick={() => onAnswer(opt.id)}
                  className={`rounded-xl p-4 font-semibold text-left flex items-center gap-3 active:scale-[0.97] transition-transform ${palette[i % palette.length]}`}
                >
                  {opt.imageUrl && <img src={opt.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg" />}
                  <span>{opt.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    // reveal
    const correct = myAnswer?.correct;
    const correctOption = currentQuestion.options.find((o) => o.id === currentQuestion.correctOptionId);
    return (
      <div className="flex flex-col gap-4">
        {myAnswer ? (
          <div className={`rounded-xl p-5 border text-center flex flex-col items-center gap-1.5 ${correct ? 'border-emerald-600 bg-emerald-950/40' : 'border-red-700 bg-red-950/30'}`}>
            <span className="text-3xl">{correct ? '✅' : '❌'}</span>
            <p className="font-semibold">{correct ? t.correct : t.incorrect}</p>
            {correct && <p className="text-sm text-emerald-400 font-mono">+{myAnswer.points} {t.points}</p>}
          </div>
        ) : (
          <div className="rounded-xl p-5 border border-gray-800 bg-gray-900/40 text-center">
            <p className="text-sm text-gray-400">⏱ Time's up</p>
          </div>
        )}
        <p className="text-xs text-gray-400 text-center">{t.correctAnswer}: <span className="text-white font-semibold">{correctOption?.text}</span></p>
        {currentQuestion.source && <p className="text-[11px] text-indigo-300 text-center">📚 {t.source}: {currentQuestion.source}</p>}
        {me && (
          <p className="text-xs text-center text-gray-400">{t.yourRank}: <span className="text-white font-bold">#{myRank}</span> · {me.totalScore} {t.points}</p>
        )}
      </div>
    );
  }

  if (quiz.status === 'finished') {
    const medals = ['🥇', '🥈', '🥉'];
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-bold text-center">{t.quizFinished}</h2>
        <div className="flex flex-col gap-2">
          {leaderboard.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-3 rounded-xl px-4 py-2.5 ${p.id === me?.id ? 'bg-emerald-900/40 border border-emerald-600' : 'bg-gray-900 border border-gray-800'}`}
            >
              <span className="text-lg w-7 text-center shrink-0">{medals[i] || `#${i + 1}`}</span>
              <span className="flex-1 text-sm font-semibold truncate">{p.name}{p.id === me?.id ? ` (${t.yourRank.toLowerCase()})` : ''}</span>
              <span className="font-mono font-bold text-sm">{p.totalScore}</span>
            </div>
          ))}
        </div>
        <button onClick={onDownload} className="bg-blue-600 hover:bg-blue-500 rounded-lg py-2.5 text-sm font-bold">
          {t.downloadResults}
        </button>
      </div>
    );
  }

  return null;
}
