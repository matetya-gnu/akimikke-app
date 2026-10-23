import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  type User
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  onSnapshot
} from 'firebase/firestore';
import {
  Calendar,
  Clock,
  Users,
  Share2,
  Copy,
  Check,
  Plus,
  Trash2,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  UserPlus,
  Edit3,
  BarChart3,
  Lock,
  RefreshCw,
  ArrowRight,
  Sun,
  Moon,
  Coffee,
  XCircle,
  Info,
  ShieldCheck,
  Send
} from 'lucide-react';

// ==========================================
// 1. Firebase 初期化
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyAbFN8ECD2Cc1A9_qryAJ6aQAtftFDRBco",
  authDomain: "akimikke-app.firebaseapp.com",
  databaseURL: "https://akimikke-app-default-rtdb.firebaseio.com",
  projectId: "akimikke-app",
  storageBucket: "akimikke-app.firebasestorage.app",
  messagingSenderId: "222031669183",
  appId: "1:222031669183:web:0c9537b69660c14029e30a",
  measurementId: "G-DL234SDYSC"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'akimikke-schedule-app';

// ==========================================
// 2. 型定義 (データ構造)
// ==========================================

/** 空き時間の1区間（例: "13:00" 〜 "18:00"） */
export interface TimeRange {
  id: string;
  start: string; // "HH:MM" (24時間表記、30分単位)
  end: string;   // "HH:MM" (24時間表記、30分単位)
}

/** 1日あたりの空き時間ステータス */
export type DayStatus = 'unanswered' | 'available' | 'unavailable';

export interface DayAvailability {
  date: string;       // "YYYY-MM-DD"
  status: DayStatus;  // available: 時間帯あり, unavailable: この日は空いていない, unanswered: 未入力
  ranges: TimeRange[];
}

/** 参加者1人分の回答データ */
export interface Participant {
  participantId: string; // 同名区別用の内部一意ID
  nickname: string;
  ownerUid: string;      // 登録端末の匿名Auth UID
  pinCode: string;       // 別端末から編集する際の4桁暗証番号
  updatedAt: number;     // 最終更新タイムスタンプ (ms)
  availability: Record<string, DayAvailability>; // key: "YYYY-MM-DD"
}

/** イベント（予定調整）全体のデータ構造 */
export interface ScheduleEvent {
  eventId: string;
  title: string;
  organizerName: string;
  expectedCount: number;
  candidateDates: string[]; // ["YYYY-MM-DD", ...]
  dayStartTime: string;  // 例: "09:00"
  dayEndTime: string;    // 例: "23:00"
  createdAt: number;
  updatedAt: number;
  participants: Participant[];
}

/** 入力途中の下書き保存データ */
interface DraftData {
  eventId: string;
  participantId: string | null;
  nickname: string;
  pinCode: string;
  availability: Record<string, DayAvailability>;
  savedAt: number;
}

/** 集計結果の連続時間帯候補 */
interface RankedCandidate {
  id: string;
  date: string;
  start: string;
  end: string;
  durationMinutes: number;
  availableParticipants: Participant[];
  unavailableParticipants: Participant[];
  unansweredCount: number;
  score: number;
}

// ==========================================
// 3. ユーティリティ関数（時刻・日付・バリデーション・区間結合）
// ==========================================

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** "HH:MM" を 0:00 からの経過分に変換 */
const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/** 経過分を "HH:MM" に変換 */
const minutesToTime = (mins: number): string => {
  const clamped = Math.max(0, Math.min(24 * 60, mins));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** 指定範囲の30分刻み時刻リストを生成 */
const generateTimeOptions = (start = '08:00', end = '23:30'): string[] => {
  const startMins = timeToMinutes(start);
  const endMins = timeToMinutes(end);
  const list: string[] = [];
  for (let m = startMins; m <= endMins; m += 30) {
    list.push(minutesToTime(m));
  }
  return list;
};

/** タイムゾーンのズレを防いでローカル日付を "YYYY-MM-DD" に変換 */
const formatLocalYMD = (d: Date): string => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** "YYYY-MM-DD" を「10月25日(日)」形式に変換 */
const formatJapaneseDate = (ymd: string): { short: string; full: string; weekday: string; isWeekend: boolean; dayOfWeek: number } => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayOfWeek = dateObj.getDay();
  const weekday = WEEKDAYS[dayOfWeek];
  return {
    short: `${m}/${d}(${weekday})`,
    full: `${m}月${d}日(${weekday})`,
    weekday,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    dayOfWeek
  };
};

/** 相対・日時フォーマット */
const formatUpdatedTime = (ms: number): string => {
  const d = new Date(ms);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${mins}`;
};

/** 重複・隣接する時間帯（例: 13:00〜18:00 と 17:00〜20:00）を自動結合し時刻順に整列 */
const mergeTimeRanges = (ranges: TimeRange[]): { merged: TimeRange[]; didMerge: boolean } => {
  if (ranges.length <= 1) return { merged: ranges, didMerge: false };
  const validRanges = ranges.filter(r => timeToMinutes(r.start) < timeToMinutes(r.end));
  const sorted = [...validRanges].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

  const result: TimeRange[] = [];
  let didMerge = false;

  for (const current of sorted) {
    if (result.length === 0) {
      result.push({ ...current });
    } else {
      const last = result[result.length - 1];
      const lastEnd = timeToMinutes(last.end);
      const currStart = timeToMinutes(current.start);
      const currEnd = timeToMinutes(current.end);

      // 重複または隣接している場合は結合
      if (currStart <= lastEnd) {
        didMerge = true;
        if (currEnd > lastEnd) {
          last.end = minutesToTime(currEnd);
        }
      } else {
        result.push({ ...current });
      }
    }
  }

  return { merged: result, didMerge };
};

/** 明日からの候補日リストを生成 */
const getUpcomingDates = (daysCount: number, offsetDays = 1): string[] => {
  const result: string[] = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = offsetDays; i < offsetDays + daysCount; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    result.push(formatLocalYMD(d));
  }
  return result;
};

// ==========================================
// 4. 集計アルゴリズム（30分単位スライス＆極大連続区間抽出）
// ==========================================
const calculateAggregatedResults = (
  event: ScheduleEvent,
  minDurationMinutes = 60
): {
  rankings: RankedCandidate[];
  dailyTimeline: Record<string, { time: string; endTime: string; available: Participant[]; unavailable: Participant[]; unansweredCount: number }[]>;
} => {
  const startMins = timeToMinutes(event.dayStartTime);
  const endMins = timeToMinutes(event.dayEndTime);
  const answeredCount = event.participants.length;
  const unansweredGlobalCount = Math.max(0, event.expectedCount - answeredCount);

  const dailyTimeline: Record<string, { time: string; endTime: string; available: Participant[]; unavailable: Participant[]; unansweredCount: number }[]> = {};
  const rawIntervals: RankedCandidate[] = [];

  for (const date of event.candidateDates) {
    const slots: { time: string; endTime: string; available: Participant[]; unavailable: Participant[]; unansweredCount: number }[] = [];

    for (let m = startMins; m < endMins; m += 30) {
      const slotStart = m;
      const slotEnd = m + 30;
      const available: Participant[] = [];
      const unavailable: Participant[] = [];
      let unansweredForDay = unansweredGlobalCount;

      for (const p of event.participants) {
        const dayData = p.availability[date];
        if (!dayData || dayData.status === 'unanswered') {
          unansweredForDay += 1;
        } else if (dayData.status === 'unavailable') {
          unavailable.push(p);
        } else {
          const isFree = dayData.ranges.some(r => {
            const rStart = timeToMinutes(r.start);
            const rEnd = timeToMinutes(r.end);
            return rStart <= slotStart && rEnd >= slotEnd;
          });
          if (isFree) {
            available.push(p);
          } else {
            unavailable.push(p);
          }
        }
      }

      slots.push({
        time: minutesToTime(slotStart),
        endTime: minutesToTime(slotEnd),
        available,
        unavailable,
        unansweredCount: unansweredForDay
      });
    }

    dailyTimeline[date] = slots;

    const numSlots = slots.length;
    for (let i = 0; i < numSlots; i++) {
      if (slots[i].available.length === 0) continue;

      let currentAvail = [...slots[i].available];

      for (let j = i; j < numSlots; j++) {
        const nextIds = new Set(slots[j].available.map(p => p.participantId));
        currentAvail = currentAvail.filter(p => nextIds.has(p.participantId));

        if (currentAvail.length === 0) break;

        const duration = (j - i + 1) * 30;
        if (duration < minDurationMinutes) continue;

        const canExtendLeft =
          i > 0 &&
          currentAvail.every(p => slots[i - 1].available.some(ap => ap.participantId === p.participantId));

        const canExtendRight =
          j < numSlots - 1 &&
          currentAvail.every(p => slots[j + 1].available.some(ap => ap.participantId === p.participantId));

        if (!canExtendLeft && !canExtendRight) {
          const availIds = new Set(currentAvail.map(p => p.participantId));
          const unavailList = event.participants.filter(p => {
            const dData = p.availability[date];
            if (!dData || dData.status === 'unanswered') return false;
            return !availIds.has(p.participantId);
          });
          const unansweredDayCount =
            unansweredGlobalCount +
            event.participants.filter(p => !p.availability[date] || p.availability[date].status === 'unanswered').length;

          rawIntervals.push({
            id: `${date}-${slots[i].time}-${slots[j].endTime}-${currentAvail.length}`,
            date,
            start: slots[i].time,
            end: slots[j].endTime,
            durationMinutes: duration,
            availableParticipants: currentAvail,
            unavailableParticipants: unavailList,
            unansweredCount: unansweredDayCount,
            score: currentAvail.length * 10000 + duration
          });
        }
      }
    }
  }

  rawIntervals.sort((a, b) => {
    if (b.availableParticipants.length !== a.availableParticipants.length) {
      return b.availableParticipants.length - a.availableParticipants.length;
    }
    if (b.durationMinutes !== a.durationMinutes) {
      return b.durationMinutes - a.durationMinutes;
    }
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    return timeToMinutes(a.start) - timeToMinutes(b.start);
  });

  const deduplicated: RankedCandidate[] = [];
  for (const cand of rawIntervals) {
    const isRedundant = deduplicated.some(existing => {
      if (existing.date !== cand.date) return false;
      const exStart = timeToMinutes(existing.start);
      const exEnd = timeToMinutes(existing.end);
      const cStart = timeToMinutes(cand.start);
      const cEnd = timeToMinutes(cand.end);
      const isInside = cStart >= exStart && cEnd <= exEnd;
      const isOverlappingSameCount =
        existing.availableParticipants.length === cand.availableParticipants.length &&
        Math.max(exStart, cStart) < Math.min(exEnd, cEnd);
      return isInside || isOverlappingSameCount;
    });

    if (!isRedundant) {
      deduplicated.push(cand);
    }
  }

  return {
    rankings: deduplicated.slice(0, 15),
    dailyTimeline
  };
};

// ==========================================
// 5. メインコンポーネント
// ==========================================
export default function App() {
  // --- Auth & Firestore State ---
  const [user, setUser] = useState<User | null>(null);
  const [eventsMap, setEventsMap] = useState<Record<string, ScheduleEvent>>({});
  const [currentEventId, setCurrentEventId] = useState<string | null>(null);
  const [userDrafts, setUserDrafts] = useState<Record<string, DraftData>>({});
  const [loadingData, setLoadingData] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // --- Navigation State ---
  const [activeScreen, setActiveScreen] = useState<'top' | 'create' | 'home' | 'input' | 'results' | 'members'>('top');

  // --- Create Event Form State ---
  const [newTitle, setNewTitle] = useState('');
  const [newOrganizer, setNewOrganizer] = useState('');
  const [newExpectedCount, setNewExpectedCount] = useState(6);
  const [newDayStart, setNewDayStart] = useState('09:00');
  const [newDayEnd, setNewDayEnd] = useState('23:00');
  const [selectedCandidateDates, setSelectedCandidateDates] = useState<string[]>(() => getUpcomingDates(5, 1));
  const [calendarBaseMonth, setCalendarBaseMonth] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  // --- Availability Input State ---
  const [editingParticipantId, setEditingParticipantId] = useState<string | null>(null);
  const [inputNickname, setInputNickname] = useState('');
  const [inputPinCode, setInputPinCode] = useState('1234');
  const [selectedDateIndex, setSelectedDateIndex] = useState(0);
  const [availabilityDraft, setAvailabilityDraft] = useState<Record<string, DayAvailability>>({});
  const [pickerStart, setPickerStart] = useState('13:00');
  const [pickerEnd, setPickerEnd] = useState('18:00');
  const [rangeWarning, setRangeWarning] = useState<string | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copyTargetDates, setCopyTargetDates] = useState<string[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // --- Drag Selection State (ドラッグで空き時間を追加) ---
  const [dragState, setDragState] = useState<{
    date: string;
    startMins: number;
    currentMins: number;
  } | null>(null);

  // --- PIN Verification Modal for other devices ---
  const [pinPromptTarget, setPinPromptTarget] = useState<Participant | null>(null);
  const [pinPromptInput, setPinPromptInput] = useState('');
  const [pinPromptError, setPinPromptError] = useState<string | null>(null);

  // --- Aggregation Filter State ---
  const [minDurationFilter, setMinDurationFilter] = useState<number>(60);
  const [selectedTimelineDate, setSelectedTimelineDate] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, 3200);
  };

  // ==========================================
  // 1) Firebase Authentication 初期化
  // ==========================================
  useEffect(() => {
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (err) {
        console.error('Auth initialization error:', err);
        setErrorMessage('認証の初期化に失敗しました。通信環境を確認して再読み込みしてください。');
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  // URLパラメータ (?event=...) の読み取り
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const evId = params.get('event');
      if (evId) {
        setCurrentEventId(evId);
        setActiveScreen('home');
      }
    } catch {
      // ignore URL parsing issues
    }
  }, []);

  // ==========================================
  // 2) Firestore リアルタイム購読
  // ==========================================
  useEffect(() => {
    if (!user) return;

    const eventsCol = collection(db, 'artifacts', appId, 'public', 'data', 'schedule_events');
    const unsubEvents = onSnapshot(
      eventsCol,
      (snapshot) => {
        const nextMap: Record<string, ScheduleEvent> = {};
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as ScheduleEvent;
          if (data && data.eventId) {
            nextMap[data.eventId] = data;
          }
        });
        setEventsMap(nextMap);
        setLoadingData(false);
      },
      (err) => {
        console.error('Firestore events listener error:', err);
        setErrorMessage('データの同期中にエラーが発生しました。再読み込みをお試しください。');
        setLoadingData(false);
      }
    );

    const draftsCol = collection(db, 'artifacts', appId, 'users', user.uid, 'drafts');
    const unsubDrafts = onSnapshot(
      draftsCol,
      (snapshot) => {
        const nextDrafts: Record<string, DraftData> = {};
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as DraftData;
          if (data && data.eventId) {
            nextDrafts[data.eventId] = data;
          }
        });
        setUserDrafts(nextDrafts);
      },
      (err) => {
        console.error('Firestore drafts listener error:', err);
      }
    );

    return () => {
      unsubEvents();
      unsubDrafts();
    };
  }, [user]);

  const currentEvent: ScheduleEvent | null = useMemo(() => {
    if (!currentEventId) return null;
    return eventsMap[currentEventId] || null;
  }, [currentEventId, eventsMap]);

  useEffect(() => {
    if (currentEvent && currentEvent.candidateDates.length > 0) {
      if (!selectedTimelineDate || !currentEvent.candidateDates.includes(selectedTimelineDate)) {
        setSelectedTimelineDate(currentEvent.candidateDates[0]);
      }
    }
  }, [currentEvent, selectedTimelineDate]);

  const aggregated = useMemo(() => {
    if (!currentEvent) return null;
    return calculateAggregatedResults(currentEvent, minDurationFilter);
  }, [currentEvent, minDurationFilter]);

  // ==========================================
  // 3) アクション関数（イベント作成・下書き保存・回答送信）
  // ==========================================

  /** 新規予定調整イベントを作成 */
  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const trimmedTitle = newTitle.trim();
    const trimmedOrg = newOrganizer.trim() || '幹事';
    if (!trimmedTitle) {
      setErrorMessage('イベント名を入力してください。');
      return;
    }
    if (selectedCandidateDates.length === 0) {
      setErrorMessage('候補日を1日以上選択してください。');
      return;
    }
    if (timeToMinutes(newDayStart) >= timeToMinutes(newDayEnd)) {
      setErrorMessage('集合可能時間帯の終了時刻は開始時刻より後にしてください。');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      const sortedDates = [...selectedCandidateDates].sort();
      const eventId = `ev-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
      const newEvent: ScheduleEvent = {
        eventId,
        title: trimmedTitle,
        organizerName: trimmedOrg,
        expectedCount: Math.max(2, Math.min(50, newExpectedCount)),
        candidateDates: sortedDates,
        dayStartTime: newDayStart,
        dayEndTime: newDayEnd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        participants: []
      };

      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'schedule_events', eventId);
      await setDoc(docRef, newEvent);

      setCurrentEventId(eventId);
      startNewParticipantInput(newEvent, trimmedOrg);
      showToast('予定調整を作成しました！続けてあなたの空き時間を登録できます');
    } catch (err) {
      console.error('Create event error:', err);
      setErrorMessage('予定調整の作成に失敗しました。もう一度お試しください。');
    } finally {
      setIsSaving(false);
    }
  };

  /** 空き時間入力画面を開始（新規または復元） */
  const startNewParticipantInput = (ev: ScheduleEvent, defaultName = '') => {
    const savedDraft = userDrafts[ev.eventId];
    if (savedDraft && !savedDraft.participantId) {
      setEditingParticipantId(null);
      setInputNickname(savedDraft.nickname || defaultName);
      setInputPinCode(savedDraft.pinCode || '1234');
      setAvailabilityDraft(savedDraft.availability || {});
      setSelectedDateIndex(0);
      setPickerStart(ev.dayStartTime);
      setPickerEnd(minutesToTime(Math.min(timeToMinutes(ev.dayEndTime), timeToMinutes(ev.dayStartTime) + 300)));
      setActiveScreen('input');
      showToast('前回入力途中の下書きを復元しました');
      return;
    }

    const initialAvail: Record<string, DayAvailability> = {};
    ev.candidateDates.forEach(d => {
      initialAvail[d] = { date: d, status: 'unanswered', ranges: [] };
    });

    setEditingParticipantId(null);
    setInputNickname(defaultName);
    setInputPinCode('1234');
    setAvailabilityDraft(initialAvail);
    setSelectedDateIndex(0);
    setPickerStart('13:00');
    setPickerEnd('18:00');
    setRangeWarning(null);
    setActiveScreen('input');
  };

  /** 既存参加者の編集を開始 */
  const handleRequestEditParticipant = (p: Participant) => {
    if (!currentEvent) return;
    if (user && p.ownerUid === user.uid) {
      openParticipantEditor(p);
    } else {
      setPinPromptTarget(p);
      setPinPromptInput('');
      setPinPromptError(null);
    }
  };

  const openParticipantEditor = (p: Participant) => {
    if (!currentEvent) return;
    const clonedAvail: Record<string, DayAvailability> = {};
    currentEvent.candidateDates.forEach(d => {
      const existing = p.availability[d];
      if (existing) {
        clonedAvail[d] = {
          date: d,
          status: existing.status,
          ranges: existing.ranges.map(r => ({ ...r }))
        };
      } else {
        clonedAvail[d] = { date: d, status: 'unanswered', ranges: [] };
      }
    });

    setEditingParticipantId(p.participantId);
    setInputNickname(p.nickname);
    setInputPinCode(p.pinCode || '1234');
    setAvailabilityDraft(clonedAvail);
    setSelectedDateIndex(0);
    setRangeWarning(null);
    setPinPromptTarget(null);
    setActiveScreen('input');
  };

  /** 入力途中の内容をクラウド下書きとして自動保存 */
  const saveDraftToCloud = async (
    nextAvail: Record<string, DayAvailability>,
    nextName = inputNickname,
    nextPin = inputPinCode
  ) => {
    if (!user || !currentEvent) return;
    try {
      const draftRef = doc(db, 'artifacts', appId, 'users', user.uid, 'drafts', currentEvent.eventId);
      const payload: DraftData = {
        eventId: currentEvent.eventId,
        participantId: editingParticipantId,
        nickname: nextName,
        pinCode: nextPin,
        availability: nextAvail,
        savedAt: Date.now()
      };
      await setDoc(draftRef, payload);
    } catch (err) {
      console.error('Draft auto-save error:', err);
    }
  };

  // ==========================================
  // 4) 空き時間レンジ操作（追加・ドラッグ・プリセット・終日・削除・コピー）
  // ==========================================
  const currentEditingDate = currentEvent ? currentEvent.candidateDates[selectedDateIndex] : '';
  const currentDayData: DayAvailability = currentEditingDate && availabilityDraft[currentEditingDate]
    ? availabilityDraft[currentEditingDate]
    : { date: currentEditingDate, status: 'unanswered', ranges: [] };

  /** 任意の日付に時間帯レンジ（開始〜終了）を追加（既存データを消さずに自動結合） */
  const handleAddTimeRangeForDate = (targetDate: string, startStr: string, endStr: string) => {
    if (!targetDate) return;
    setRangeWarning(null);

    const startM = timeToMinutes(startStr);
    const endM = timeToMinutes(endStr);

    if (startM >= endM) {
      setRangeWarning('終了時刻は開始時刻より後の時間を選んでください（例: 13:00 〜 18:00）');
      return;
    }

    const newRange: TimeRange = {
      id: `rng-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      start: startStr,
      end: endStr
    };

    const targetDayData = availabilityDraft[targetDate] || {
      date: targetDate,
      status: 'unanswered',
      ranges: []
    };

    const existingRanges = targetDayData.status === 'available' ? targetDayData.ranges : [];
    const { merged, didMerge } = mergeTimeRanges([...existingRanges, newRange]);

    const nextAvail: Record<string, DayAvailability> = {
      ...availabilityDraft,
      [targetDate]: {
        date: targetDate,
        status: 'available',
        ranges: merged
      }
    };

    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);

    if (didMerge) {
      showToast(`${formatJapaneseDate(targetDate).short} の重なる時間帯を自動でまとめました✨`);
    } else {
      showToast(`${formatJapaneseDate(targetDate).short} に ${startStr}〜${endStr} を追加しました`);
    }
  };

  /** 現在選択中の日付に時間帯を追加 */
  const handleAddTimeRange = (startStr: string, endStr: string) => {
    handleAddTimeRangeForDate(currentEditingDate, startStr, endStr);
  };

  /** ドラッグ操作の完了処理（マウスを離した時に空き時間を追加） */
  useEffect(() => {
    if (!dragState) return;

    const handleGlobalMouseUp = () => {
      const minSlot = Math.min(dragState.startMins, dragState.currentMins);
      const maxSlot = Math.max(dragState.startMins, dragState.currentMins) + 30;
      const startStr = minutesToTime(minSlot);
      const endStr = minutesToTime(maxSlot);
      const targetDate = dragState.date;

      setDragState(null);
      handleAddTimeRangeForDate(targetDate, startStr, endStr);
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('touchend', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('touchend', handleGlobalMouseUp);
    };
  });

  /** 「終日空いている」をワンタップでセット */
  const handleSetAllDayAvailable = () => {
    if (!currentEvent || !currentEditingDate) return;
    setRangeWarning(null);
    const fullRange: TimeRange = {
      id: `rng-allday-${Date.now()}`,
      start: currentEvent.dayStartTime,
      end: currentEvent.dayEndTime
    };
    const nextAvail: Record<string, DayAvailability> = {
      ...availabilityDraft,
      [currentEditingDate]: {
        date: currentEditingDate,
        status: 'available',
        ranges: [fullRange]
      }
    };
    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);
    showToast(`終日空いている（${currentEvent.dayStartTime}〜${currentEvent.dayEndTime}）に設定しました`);
  };

  /** 「この日は空いていない（終日NG）」をワンタップでセット */
  const handleSetDayUnavailable = () => {
    if (!currentEditingDate) return;
    setRangeWarning(null);
    const nextAvail: Record<string, DayAvailability> = {
      ...availabilityDraft,
      [currentEditingDate]: {
        date: currentEditingDate,
        status: 'unavailable',
        ranges: []
      }
    };
    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);
    showToast('「この日は空いていない」に設定しました');
  };

  /** 指定日の特定の時間帯カードを削除 */
  const handleRemoveTimeRangeForDate = (targetDate: string, rangeId: string) => {
    const dayData = availabilityDraft[targetDate];
    if (!dayData) return;
    const filtered = dayData.ranges.filter(r => r.id !== rangeId);
    const nextAvail: Record<string, DayAvailability> = {
      ...availabilityDraft,
      [targetDate]: {
        date: targetDate,
        status: filtered.length > 0 ? 'available' : 'unanswered',
        ranges: filtered
      }
    };
    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);
  };

  /** 現在選択中の日の時間帯カードを削除 */
  const handleRemoveTimeRange = (rangeId: string) => {
    handleRemoveTimeRangeForDate(currentEditingDate, rangeId);
  };

  /** 登録済み時間帯カードの開始・終了時刻を直接修正 */
  const handleUpdateTimeRange = (rangeId: string, field: 'start' | 'end', value: string) => {
    if (!currentEditingDate) return;
    setRangeWarning(null);

    const updatedRanges = currentDayData.ranges.map(r => {
      if (r.id !== rangeId) return r;
      const nextStart = field === 'start' ? value : r.start;
      const nextEnd = field === 'end' ? value : r.end;
      if (timeToMinutes(nextStart) >= timeToMinutes(nextEnd)) {
        setRangeWarning('開始時刻は終了時刻より前にしてください');
        return r;
      }
      return { ...r, start: nextStart, end: nextEnd };
    });

    const { merged } = mergeTimeRanges(updatedRanges);
    const nextAvail: Record<string, DayAvailability> = {
      ...availabilityDraft,
      [currentEditingDate]: {
        date: currentEditingDate,
        status: 'available',
        ranges: merged
      }
    };
    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);
  };

  /** この日の空き時間を他の日付へ一括コピー */
  const handleApplyCopyToDates = () => {
    if (!currentEditingDate || copyTargetDates.length === 0) return;
    const sourceDay = currentDayData;
    const nextAvail = { ...availabilityDraft };

    copyTargetDates.forEach(targetDate => {
      nextAvail[targetDate] = {
        date: targetDate,
        status: sourceDay.status,
        ranges: sourceDay.ranges.map(r => ({
          ...r,
          id: `rng-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
        }))
      };
    });

    setAvailabilityDraft(nextAvail);
    saveDraftToCloud(nextAvail);
    setShowCopyModal(false);
    setCopyTargetDates([]);
    showToast(`${copyTargetDates.length}日分に空き時間をコピーしました！`);
  };

  /** 入力内容の事前チェック＆確認モーダル表示 */
  const handleOpenSubmitConfirmation = () => {
    setErrorMessage(null);
    if (!inputNickname.trim()) {
      setErrorMessage('あなたのニックネームを入力してください。');
      return;
    }
    const answeredDays = Object.values(availabilityDraft).filter(d => d.status !== 'unanswered');
    if (answeredDays.length === 0) {
      setErrorMessage('少なくとも1日以上の空き時間（または「空いていない」）を登録してください。');
      return;
    }
    setShowConfirmModal(true);
  };

  /** Firestoreへ参加者の回答を保存 */
  const handleConfirmSaveParticipant = async () => {
    if (!user || !currentEvent) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const pId = editingParticipantId || `p-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5)}`;
      const newParticipant: Participant = {
        participantId: pId,
        nickname: inputNickname.trim(),
        ownerUid: user.uid,
        pinCode: (inputPinCode.trim() || '1234').slice(0, 4),
        updatedAt: Date.now(),
        availability: availabilityDraft
      };

      const existingList = currentEvent.participants || [];
      const existsIndex = existingList.findIndex(p => p.participantId === pId);
      const nextParticipants =
        existsIndex >= 0
          ? existingList.map((p, idx) => (idx === existsIndex ? newParticipant : p))
          : [...existingList, newParticipant];

      const updatedEvent: ScheduleEvent = {
        ...currentEvent,
        updatedAt: Date.now(),
        participants: nextParticipants
      };

      const eventRef = doc(db, 'artifacts', appId, 'public', 'data', 'schedule_events', currentEvent.eventId);
      await setDoc(eventRef, updatedEvent);

      setShowConfirmModal(false);
      setActiveScreen('results');
      showToast('空き時間を登録しました！みんなの集計結果が更新されました🎉');
    } catch (err) {
      console.error('Save participant error:', err);
      setErrorMessage('回答の保存に失敗しました。通信環境を確認してもう一度お試しください。');
    } finally {
      setIsSaving(false);
    }
  };

  /** 参加者の回答データを削除 */
  const handleDeleteParticipant = async (participantId: string) => {
    if (!user || !currentEvent) return;
    setIsSaving(true);
    try {
      const nextParticipants = currentEvent.participants.filter(p => p.participantId !== participantId);
      const eventRef = doc(db, 'artifacts', appId, 'public', 'data', 'schedule_events', currentEvent.eventId);
      await setDoc(eventRef, {
        ...currentEvent,
        updatedAt: Date.now(),
        participants: nextParticipants
      });
      setActiveScreen('home');
      showToast('回答データを削除しました');
    } catch (err) {
      console.error('Delete participant error:', err);
      setErrorMessage('削除に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  /** 共有URLの生成とコピー / LINE共有 */
  const shareUrl = useMemo(() => {
    if (!currentEvent) return window.location.href;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('event', currentEvent.eventId);
      return url.toString();
    } catch {
      return `${window.location.origin}/?event=${currentEvent.eventId}`;
    }
  }, [currentEvent]);

  const handleCopyShareUrl = async () => {
    if (!currentEvent) return;
    const shareText = `【${currentEvent.title}】の予定調整！\n空いている時間帯をまとめて登録してね👇\n${shareUrl}`;
    try {
      await navigator.clipboard.writeText(shareText);
      showToast('LINE共有用のメッセージとURLをコピーしました！');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showToast('URLをコピーしました！');
    }
  };

  const handleShareOnLine = () => {
    if (!currentEvent) return;
    const text = `【${currentEvent.title}】\nみんなの空き時間を調整中！30分ごとの○×入力なしでサクッと登録できます👇\n${shareUrl}`;
    const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
    window.open(lineUrl, '_blank', 'noopener,noreferrer');
  };

  // カレンダー生成用（作成画面）
  const calendarDays = useMemo(() => {
    const year = calendarBaseMonth.getFullYear();
    const month = calendarBaseMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPad = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const cells: (string | null)[] = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= totalDays; d++) {
      cells.push(formatLocalYMD(new Date(year, month, d)));
    }
    return { year, month: month + 1, cells };
  }, [calendarBaseMonth]);

  const timeSelectOptions = useMemo(() => {
    if (!currentEvent) return generateTimeOptions('08:00', '23:30');
    return generateTimeOptions(currentEvent.dayStartTime, currentEvent.dayEndTime);
  }, [currentEvent]);

  // ドラッググリッド用の30分刻みスロット配列（開始時刻分）
  const gridTimeSlots = useMemo(() => {
    if (!currentEvent) return [];
    const startM = timeToMinutes(currentEvent.dayStartTime);
    const endM = timeToMinutes(currentEvent.dayEndTime);
    const slots: number[] = [];
    for (let m = startM; m < endM; m += 30) {
      slots.push(m);
    }
    return slots;
  }, [currentEvent]);

  // ==========================================
  // 6. レンダリング
  // ==========================================
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 pb-28 md:pb-12 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* トースト通知 */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-md bg-slate-900/95 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2.5 text-sm font-medium animate-bounce">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 上部ヘッダー（スマホ・PC両対応） */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <button
            onClick={() => setActiveScreen('top')}
            className="flex items-center gap-2.5 text-left group focus:outline-none shrink-0"
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-sm">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-lg tracking-tight text-slate-900">アキミッケ</span>
                <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                  時間帯・ドラッグ入力対応
                </span>
              </div>
              <p className="text-[11px] text-slate-500 leading-none">30分ごとの○×不要！みんなの空き時間調整</p>
            </div>
          </button>

          {/* PC用ヘッダーナビゲーション */}
          {currentEvent && activeScreen !== 'top' && activeScreen !== 'create' && (
            <div className="hidden md:flex items-center gap-1 bg-slate-100 p-1 rounded-2xl">
              <button
                onClick={() => setActiveScreen('home')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeScreen === 'home' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Share2 className="w-4 h-4" />
                <span>共有・ホーム</span>
              </button>
              <button
                onClick={() => {
                  if (activeScreen !== 'input') startNewParticipantInput(currentEvent);
                }}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeScreen === 'input' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Clock className="w-4 h-4" />
                <span>空き時間入力</span>
              </button>
              <button
                onClick={() => setActiveScreen('results')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeScreen === 'results' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BarChart3 className="w-4 h-4" />
                <span>集計ランキング</span>
              </button>
              <button
                onClick={() => setActiveScreen('members')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeScreen === 'members' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>回答状況 ({currentEvent.participants.length})</span>
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            {activeScreen !== 'top' && (
              <button
                onClick={() => setActiveScreen('top')}
                className="text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-3 py-2 rounded-xl transition"
              >
                トップ・一覧へ
              </button>
            )}
          </div>
        </div>
      </header>

      {/* メインコンテナ（スマホ＆PCレスポンシブ対応） */}
      <main className="max-w-5xl mx-auto px-4 pt-5">
        {/* エラーメッセージバナー */}
        {errorMessage && (
          <div className="mb-5 bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-start gap-2.5 text-rose-800 text-sm">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-bold">確認してください</p>
              <p className="text-xs mt-0.5 leading-relaxed">{errorMessage}</p>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-rose-500 hover:text-rose-700 text-xs font-bold px-2 py-1"
            >
              閉じる
            </button>
          </div>
        )}

        {/* ====================================================
            画面1: トップ画面
        ==================================================== */}
        {activeScreen === 'top' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* 左カラム: ヒーローカード & 使い方 */}
            <div className="lg:col-span-7 space-y-5">
              <div className="bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 rounded-3xl p-6 sm:p-8 text-white shadow-lg">
                <div className="inline-flex items-center gap-1.5 bg-white/20 backdrop-blur px-3 py-1 rounded-full text-xs font-bold mb-3">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>LINEグループの予定調整に最適！</span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold leading-snug mb-3">
                  30分ごとの○×ポチポチは<br />もう終わり！
                </h1>
                <p className="text-emerald-50 text-sm sm:text-base leading-relaxed mb-6">
                  「13:00〜18:00」のように時間帯をまとめて選ぶか、カレンダーをドラッグしてなぞるだけ。みんなが集まれるベストな日時を自動で見つけます。
                </p>

                <button
                  onClick={() => {
                    setErrorMessage(null);
                    setActiveScreen('create');
                  }}
                  className="w-full py-4 px-5 bg-white text-emerald-900 font-extrabold text-base rounded-2xl shadow-md hover:bg-emerald-50 active:scale-[0.99] transition flex items-center justify-center gap-2"
                >
                  <Plus className="w-5 h-5 text-emerald-600 stroke-[2.5]" />
                  <span>新しい予定調整を作る</span>
                </button>
              </div>

              {/* 使い方3ステップ */}
              <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-sm">
                <h2 className="font-bold text-slate-900 text-base mb-4 flex items-center gap-2">
                  <Info className="w-5 h-5 text-emerald-600" />
                  <span>かんたん3ステップの使い方</span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="flex sm:flex-col items-start gap-3 bg-slate-50 p-4 rounded-2xl">
                    <span className="w-7 h-7 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      1
                    </span>
                    <div>
                      <p className="font-bold text-sm text-slate-900">候補日を選んでLINEでURL共有</p>
                      <p className="text-xs text-slate-600 mt-1">アプリ登録・ログイン不要。URLを開くだけで参加できます。</p>
                    </div>
                  </div>
                  <div className="flex sm:flex-col items-start gap-3 bg-slate-50 p-4 rounded-2xl">
                    <span className="w-7 h-7 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      2
                    </span>
                    <div>
                      <p className="font-bold text-sm text-slate-900">ドラッグやボタンで空き時間を登録</p>
                      <p className="text-xs text-slate-600 mt-1">カレンダーをなぞるか、「13:00〜18:00」などのボタンでサクッと入力！</p>
                    </div>
                  </div>
                  <div className="flex sm:flex-col items-start gap-3 bg-slate-50 p-4 rounded-2xl">
                    <span className="w-7 h-7 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      3
                    </span>
                    <div>
                      <p className="font-bold text-sm text-slate-900">集まれる日時ランキングを自動抽出</p>
                      <p className="text-xs text-slate-600 mt-1">参加できる人・できない人・未回答の人がひと目でわかります。</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 右カラム: 保存済みの予定調整一覧 */}
            <div className="lg:col-span-5 bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-slate-900 text-base flex items-center gap-2">
                  <Users className="w-5 h-5 text-teal-600" />
                  <span>作成・共有されている予定調整</span>
                </h2>
                {loadingData && (
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 同期中
                  </span>
                )}
              </div>

              {Object.keys(eventsMap).length === 0 ? (
                <div className="text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-200 px-4">
                  <p className="text-sm font-semibold text-slate-600 mb-1">まだ予定調整がありません</p>
                  <p className="text-xs text-slate-500">
                    「新しい予定調整を作る」から最初のイベントを作成してください。
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {Object.values(eventsMap)
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .map(ev => {
                      const answered = ev.participants?.length || 0;
                      return (
                        <button
                          key={ev.eventId}
                          onClick={() => {
                            setCurrentEventId(ev.eventId);
                            setActiveScreen('home');
                          }}
                          className="w-full text-left p-4 rounded-2xl border border-slate-200 hover:border-emerald-400 hover:bg-emerald-50/40 transition flex items-center justify-between gap-3 group"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900 text-sm truncate">{ev.title}</span>
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 shrink-0">
                                {answered}人回答
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 mt-1">
                              候補日: {ev.candidateDates.length}日間 ({ev.dayStartTime}〜{ev.dayEndTime}) ・ 幹事: {ev.organizerName}
                            </p>
                          </div>
                          <ChevronRight className="w-5 h-5 text-slate-400 group-hover:text-emerald-600 shrink-0" />
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====================================================
            画面2: 予定調整の作成画面
        ==================================================== */}
        {activeScreen === 'create' && (
          <form onSubmit={handleCreateEvent}>
            <div className="bg-white rounded-3xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-6">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <h1 className="text-lg sm:text-xl font-extrabold text-slate-900">新しい予定調整を作る</h1>
                <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full">
                  幹事用
                </span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 左側: 基本設定 */}
                <div className="space-y-5">
                  <div>
                    <label className="block text-sm font-bold text-slate-800 mb-1.5">
                      1. イベント名 <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={newTitle}
                      onChange={e => setNewTitle(e.target.value)}
                      placeholder="例：打ち上げご飯会、ゼミミーティング"
                      className="w-full px-4 py-3.5 rounded-2xl border border-slate-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 text-base font-medium outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-sm font-bold text-slate-800 mb-1.5">
                        2. 幹事のニックネーム
                      </label>
                      <input
                        type="text"
                        value={newOrganizer}
                        onChange={e => setNewOrganizer(e.target.value)}
                        placeholder="例：たくみ"
                        className="w-full px-4 py-3.5 rounded-2xl border border-slate-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 text-base outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-slate-800 mb-1.5">
                        参加予定人数
                      </label>
                      <select
                        value={newExpectedCount}
                        onChange={e => setNewExpectedCount(Number(e.target.value))}
                        className="w-full px-3 py-3.5 rounded-2xl border border-slate-300 bg-white font-bold text-base text-slate-800 outline-none focus:border-emerald-500"
                      >
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20].map(num => (
                          <option key={num} value={num}>
                            {num}人
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-bold text-slate-800 mb-1.5">
                      3. 集合可能な時間帯の範囲（24時間表記）
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-xs text-slate-500 block mb-1">開始時刻</span>
                        <select
                          value={newDayStart}
                          onChange={e => setNewDayStart(e.target.value)}
                          className="w-full px-3.5 py-3 rounded-2xl border border-slate-300 bg-white font-bold text-base"
                        >
                          {generateTimeOptions('06:00', '20:00').map(t => (
                            <option key={t} value={t}>
                              {t} から
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block mb-1">終了時刻</span>
                        <select
                          value={newDayEnd}
                          onChange={e => setNewDayEnd(e.target.value)}
                          className="w-full px-3.5 py-3 rounded-2xl border border-slate-300 bg-white font-bold text-base"
                        >
                          {generateTimeOptions('12:00', '24:00').map(t => (
                            <option key={t} value={t}>
                              {t} まで
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 右側: 候補日カレンダー */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-bold text-slate-800">
                      4. 候補日を選択 ({selectedCandidateDates.length}日選択中)
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <button
                      type="button"
                      onClick={() => setSelectedCandidateDates(getUpcomingDates(5, 1))}
                      className="text-xs font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-2 rounded-xl transition"
                    >
                      明日から5日間
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCandidateDates(getUpcomingDates(7, 1))}
                      className="text-xs font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-2 rounded-xl transition"
                    >
                      明日から7日間
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCandidateDates([])}
                      className="text-xs font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 px-3 py-2 rounded-xl transition"
                    >
                      クリア
                    </button>
                  </div>

                  <div className="border border-slate-200 rounded-2xl p-3.5 bg-slate-50/60">
                    <div className="flex items-center justify-between mb-2 px-1">
                      <button
                        type="button"
                        onClick={() =>
                          setCalendarBaseMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
                        }
                        className="p-2 rounded-xl hover:bg-slate-200 text-slate-700"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <span className="font-bold text-sm text-slate-800">
                        {calendarDays.year}年 {calendarDays.month}月
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setCalendarBaseMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
                        }
                        className="p-2 rounded-xl hover:bg-slate-200 text-slate-700"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-bold text-slate-500 mb-1">
                      {WEEKDAYS.map((w, idx) => (
                        <div key={w} className={idx === 0 ? 'text-rose-500' : idx === 6 ? 'text-blue-600' : ''}>
                          {w}
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-7 gap-1">
                      {calendarDays.cells.map((ymd, idx) => {
                        if (!ymd) return <div key={`empty-${idx}`} className="h-10" />;
                        const isSelected = selectedCandidateDates.includes(ymd);
                        const dayNum = Number(ymd.split('-')[2]);
                        return (
                          <button
                            type="button"
                            key={ymd}
                            onClick={() => {
                              setSelectedCandidateDates(prev =>
                                prev.includes(ymd) ? prev.filter(d => d !== ymd) : [...prev, ymd]
                              );
                            }}
                            className={`h-10 rounded-xl font-bold text-sm transition flex items-center justify-center ${
                              isSelected
                                ? 'bg-emerald-600 text-white shadow-sm scale-[1.02]'
                                : 'bg-white text-slate-700 hover:bg-emerald-50 border border-slate-200/70'
                            }`}
                          >
                            {dayNum}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-2 flex gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setActiveScreen('top')}
                  className="w-1/3 sm:w-40 py-4 rounded-2xl font-bold text-sm bg-slate-100 text-slate-700 hover:bg-slate-200 transition"
                >
                  戻る
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex-1 py-4 rounded-2xl font-extrabold text-base bg-emerald-600 text-white shadow-md hover:bg-emerald-700 transition flex items-center justify-center gap-2"
                >
                  <Check className="w-5 h-5" />
                  <span>予定調整を作成してURL発行</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* ====================================================
            画面3: 共有・参加画面（イベントホーム）
        ==================================================== */}
        {activeScreen === 'home' && currentEvent && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* 左カラム: イベント概要＆LINE共有＆第1位プレビュー */}
            <div className="lg:col-span-7 space-y-4">
              <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-4">
                <div>
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full mb-1.5">
                    <Users className="w-3.5 h-3.5" />
                    幹事: {currentEvent.organizerName} ・ 予定人数 {currentEvent.expectedCount}人
                  </span>
                  <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 leading-snug">
                    {currentEvent.title}
                  </h1>
                </div>

                {/* 回答状況プログレス */}
                <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200/70">
                  <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                    <span className="text-slate-700">
                      現在の回答状況：{currentEvent.expectedCount}人中{' '}
                      <span className="text-emerald-600 text-sm font-extrabold">
                        {currentEvent.participants.length}人
                      </span>{' '}
                      回答済み
                    </span>
                    <span className="text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                      未回答 {Math.max(0, currentEvent.expectedCount - currentEvent.participants.length)}人
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round((currentEvent.participants.length / currentEvent.expectedCount) * 100)
                        )}%`
                      }}
                    />
                  </div>
                </div>

                {/* 空き時間を登録する大型メインCTAボタン */}
                <div className="pt-1">
                  <button
                    onClick={() => startNewParticipantInput(currentEvent)}
                    className="w-full py-4 px-5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-extrabold text-base rounded-2xl shadow-md active:scale-[0.99] transition flex items-center justify-center gap-2"
                  >
                    <UserPlus className="w-5 h-5" />
                    <span>自分の空き時間を登録する</span>
                  </button>
                </div>

                {/* 共有URL & LINE共有ボタン */}
                <div className="pt-2 border-t border-slate-100 space-y-2.5">
                  <p className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                    <Share2 className="w-4 h-4 text-emerald-600" />
                    <span>LINEグループにURLを送ってみんなに回答してもらおう</span>
                  </p>

                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                    <input
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="w-full bg-transparent text-xs text-slate-600 font-mono outline-none truncate"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={handleShareOnLine}
                      className="py-3 px-4 rounded-2xl font-bold text-sm bg-[#06C755] hover:bg-[#05b34c] text-white shadow-sm transition flex items-center justify-center gap-2"
                    >
                      <Send className="w-4 h-4" />
                      <span>LINEで共有</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyShareUrl}
                      className="py-3 px-4 rounded-2xl font-bold text-sm bg-slate-800 hover:bg-slate-900 text-white shadow-sm transition flex items-center justify-center gap-2"
                    >
                      <Copy className="w-4 h-4" />
                      <span>URLをコピー</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* 現在の第1位候補プレビュー */}
              {aggregated && aggregated.rankings.length > 0 && (
                <div className="bg-emerald-50/90 border border-emerald-200 rounded-3xl p-4 sm:p-5 flex items-center justify-between gap-3">
                  <div>
                    <span className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                      現在の第1位候補
                    </span>
                    <p className="font-extrabold text-slate-900 text-base sm:text-lg mt-1">
                      {formatJapaneseDate(aggregated.rankings[0].date).full}{' '}
                      {aggregated.rankings[0].start}〜{aggregated.rankings[0].end}
                    </p>
                    <p className="text-xs text-emerald-800 font-semibold mt-0.5">
                      {currentEvent.expectedCount}人中 {aggregated.rankings[0].availableParticipants.length}人が参加可能
                      {aggregated.rankings[0].unansweredCount > 0 &&
                        `（未回答 ${aggregated.rankings[0].unansweredCount}人）`}
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveScreen('results')}
                    className="shrink-0 bg-emerald-600 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-sm hover:bg-emerald-700 transition"
                  >
                    集計詳細へ →
                  </button>
                </div>
              )}
            </div>

            {/* 右カラム: メンバーの回答状況一覧 */}
            <div className="lg:col-span-5 bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-extrabold text-slate-900 text-base flex items-center gap-2">
                  <Users className="w-5 h-5 text-emerald-600" />
                  <span>メンバーの回答状況</span>
                </h2>
                <button
                  onClick={() => setActiveScreen('members')}
                  className="text-xs font-bold text-emerald-700 hover:underline"
                >
                  詳細を見る
                </button>
              </div>

              <div className="space-y-2.5">
                {currentEvent.participants.map((p, idx) => {
                  const isMine = user && p.ownerUid === user.uid;
                  return (
                    <div
                      key={p.participantId}
                      className="p-3.5 rounded-2xl border border-slate-200 bg-slate-50/60 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="w-6 h-6 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center">
                            {idx + 1}
                          </span>
                          <span className="font-bold text-sm text-slate-900 truncate">{p.nickname}</span>
                          <span className="text-[11px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                            回答済み
                          </span>
                          {isMine && (
                            <span className="text-[10px] font-bold bg-teal-600 text-white px-2 py-0.5 rounded-full">
                              あなた
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">
                          最終更新: {formatUpdatedTime(p.updatedAt)}
                        </p>
                      </div>

                      <button
                        onClick={() => handleRequestEditParticipant(p)}
                        className="shrink-0 flex items-center gap-1 text-xs font-bold text-emerald-700 bg-white border border-emerald-200 hover:bg-emerald-50 px-3 py-2 rounded-xl transition"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>修正</span>
                      </button>
                    </div>
                  );
                })}

                {Array.from({
                  length: Math.max(0, currentEvent.expectedCount - currentEvent.participants.length)
                }).map((_, i) => {
                  const slotNumber = currentEvent.participants.length + i + 1;
                  return (
                    <div
                      key={`unanswered-slot-${slotNumber}`}
                      className="p-3.5 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/40 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="w-6 h-6 rounded-full bg-amber-200 text-amber-900 font-bold text-xs flex items-center justify-center">
                          {slotNumber}
                        </span>
                        <div>
                          <span className="font-bold text-sm text-amber-900">
                            {slotNumber}人目のメンバー（未回答）
                          </span>
                          <p className="text-[11px] text-amber-700">
                            ※未回答の人は「参加不可」ではなく「未回答」として集計されます
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => startNewParticipantInput(currentEvent)}
                        className="shrink-0 text-xs font-bold bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-xl shadow-sm transition"
                      >
                        回答する
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ====================================================
            画面4: 空き時間入力画面（従来の時間帯入力 ＋ カレンダードラッグ入力）
        ==================================================== */}
        {activeScreen === 'input' && currentEvent && (
          <div className="space-y-5">
            {/* Step 1: ニックネームと暗証キー */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-emerald-600" />
                  <h2 className="font-extrabold text-base text-slate-900">
                    {editingParticipantId ? '回答内容の修正' : 'あなたの情報を入力'}
                  </h2>
                  <span className="text-[11px] text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full font-semibold">
                    自動一時保存オン
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2.5 sm:w-96">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      ニックネーム（必須）
                    </label>
                    <input
                      type="text"
                      value={inputNickname}
                      onChange={e => {
                        setInputNickname(e.target.value);
                        saveDraftToCloud(availabilityDraft, e.target.value, inputPinCode);
                      }}
                      placeholder="例：しょうた"
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-emerald-500 font-bold text-sm outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1 flex items-center gap-1">
                      <Lock className="w-3 h-3 text-slate-400" /> 編集用4桁
                    </label>
                    <input
                      type="text"
                      maxLength={4}
                      value={inputPinCode}
                      onChange={e => {
                        setInputPinCode(e.target.value);
                        saveDraftToCloud(availabilityDraft, inputNickname, e.target.value);
                      }}
                      placeholder="1234"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-center font-mono font-bold text-sm outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* PCでは左右2カラム（左：日別のボタン＆プルダウン入力、右：複数日ドラッグカレンダー） */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* 左カラム（既存のボタン・プリセット・プルダウン入力一式を完全維持） */}
              <div className="lg:col-span-6 space-y-4">
                {/* 日付選択ボタン */}
                <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-extrabold text-sm text-slate-900">
                      日付を選んで入力（{selectedDateIndex + 1}/{currentEvent.candidateDates.length}日目）
                    </h2>
                    <span className="text-[11px] text-slate-500">
                      入力済み: {Object.values(availabilityDraft).filter(d => d.status !== 'unanswered').length}/
                      {currentEvent.candidateDates.length}日
                    </span>
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {currentEvent.candidateDates.map((d, idx) => {
                      const formatted = formatJapaneseDate(d);
                      const dState = availabilityDraft[d]?.status || 'unanswered';
                      const rangeCount = availabilityDraft[d]?.ranges?.length || 0;
                      const isSelected = idx === selectedDateIndex;

                      return (
                        <button
                          type="button"
                          key={d}
                          onClick={() => {
                            setSelectedDateIndex(idx);
                            setRangeWarning(null);
                          }}
                          className={`p-2.5 rounded-2xl border text-left transition flex flex-col justify-between ${
                            isSelected
                              ? 'border-emerald-600 bg-emerald-600 text-white shadow-md scale-[1.02]'
                              : dState === 'available'
                              ? 'border-emerald-300 bg-emerald-50/70 text-slate-900'
                              : dState === 'unavailable'
                              ? 'border-slate-300 bg-slate-100 text-slate-600'
                              : 'border-dashed border-amber-300 bg-amber-50/30 text-slate-700'
                          }`}
                        >
                          <span className="text-xs font-extrabold">{formatted.short}</span>
                          <div className="mt-1.5 flex items-center gap-1">
                            {dState === 'available' ? (
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                                  isSelected ? 'bg-white/25 text-white' : 'bg-emerald-600 text-white'
                                }`}
                              >
                                空き {rangeCount}件
                              </span>
                            ) : dState === 'unavailable' ? (
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                                  isSelected ? 'bg-white/25 text-white' : 'bg-slate-500 text-white'
                                }`}
                              >
                                予定あり
                              </span>
                            ) : (
                              <span
                                className={`text-[10px] font-semibold ${
                                  isSelected ? 'text-emerald-100' : 'text-amber-700'
                                }`}
                              >
                                未入力
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 選択中の日の時間帯まとめ入力カード */}
                {currentEditingDate && (
                  <div className="bg-white rounded-3xl p-5 border-2 border-emerald-500/80 shadow-md space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <div>
                        <span className="text-xs font-bold text-emerald-700">選択中の日付</span>
                        <h3 className="text-lg sm:text-xl font-extrabold text-slate-900">
                          {formatJapaneseDate(currentEditingDate).full} の空き時間
                        </h3>
                      </div>
                    </div>

                    {/* ワンタップ「終日空いている」「この日は空いていない」 */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={handleSetAllDayAvailable}
                        className={`py-3.5 px-3 rounded-2xl font-extrabold text-xs sm:text-sm border transition flex items-center justify-center gap-1.5 ${
                          currentDayData.status === 'available' &&
                          currentDayData.ranges.length === 1 &&
                          currentDayData.ranges[0].start === currentEvent.dayStartTime &&
                          currentDayData.ranges[0].end === currentEvent.dayEndTime
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                            : 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100'
                        }`}
                      >
                        <Sun className="w-4 h-4 shrink-0" />
                        <span>終日空いている ({currentEvent.dayStartTime}〜{currentEvent.dayEndTime})</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSetDayUnavailable}
                        className={`py-3.5 px-3 rounded-2xl font-extrabold text-xs sm:text-sm border transition flex items-center justify-center gap-1.5 ${
                          currentDayData.status === 'unavailable'
                            ? 'bg-slate-800 text-white border-slate-800 shadow-sm'
                            : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                        }`}
                      >
                        <XCircle className="w-4 h-4 shrink-0" />
                        <span>この日は空いていない</span>
                      </button>
                    </div>

                    {/* よく使う時間帯プリセット */}
                    <div className="space-y-1.5">
                      <p className="text-xs font-bold text-slate-600">
                        よく使う時間帯をワンタップで追加（複数組み合わせOK）：
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleAddTimeRange('09:00', '13:00')}
                          className="py-2.5 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 font-bold text-xs flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1">
                            <Coffee className="w-3.5 h-3.5 text-teal-600" /> 午前
                          </span>
                          <span className="font-mono">09:00〜13:00 ＋</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleAddTimeRange('13:00', '18:00')}
                          className="py-2.5 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 font-bold text-xs flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1">
                            <Sun className="w-3.5 h-3.5 text-amber-500" /> 昼〜夕方
                          </span>
                          <span className="font-mono">13:00〜18:00 ＋</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleAddTimeRange('18:00', '23:00')}
                          className="py-2.5 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 font-bold text-xs flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1">
                            <Moon className="w-3.5 h-3.5 text-indigo-500" /> 18時以降
                          </span>
                          <span className="font-mono">18:00〜23:00 ＋</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleAddTimeRange('21:00', '23:00')}
                          className="py-2.5 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 font-bold text-xs flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1">
                            <Sparkles className="w-3.5 h-3.5 text-purple-500" /> 21時以降
                          </span>
                          <span className="font-mono">21:00〜23:00 ＋</span>
                        </button>
                      </div>
                    </div>

                    {/* 自由な開始時刻〜終了時刻セレクター */}
                    <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200 space-y-3">
                      <p className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-emerald-600" />
                        <span>時間を自由に指定して追加（24時間表記）</span>
                      </p>

                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <label className="text-[11px] font-semibold text-slate-500 block mb-1">開始時刻</label>
                          <select
                            value={pickerStart}
                            onChange={e => setPickerStart(e.target.value)}
                            className="w-full px-3 py-3 rounded-xl border border-slate-300 bg-white font-mono font-extrabold text-base text-slate-900"
                          >
                            {timeSelectOptions.slice(0, -1).map(t => (
                              <option key={`start-${t}`} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>

                        <span className="font-extrabold text-slate-400 pt-5">〜</span>

                        <div className="flex-1">
                          <label className="text-[11px] font-semibold text-slate-500 block mb-1">終了時刻</label>
                          <select
                            value={pickerEnd}
                            onChange={e => setPickerEnd(e.target.value)}
                            className="w-full px-3 py-3 rounded-xl border border-slate-300 bg-white font-mono font-extrabold text-base text-slate-900"
                          >
                            {timeSelectOptions.slice(1).map(t => (
                              <option key={`end-${t}`} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {rangeWarning && (
                        <p className="text-xs font-bold text-rose-600 bg-rose-50 px-3 py-2 rounded-xl flex items-center gap-1.5">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{rangeWarning}</span>
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => handleAddTimeRange(pickerStart, pickerEnd)}
                        className="w-full py-3.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-sm shadow-sm transition flex items-center justify-center gap-1.5"
                      >
                        <Plus className="w-5 h-5" />
                        <span>＋ 空いている時間を追加（{pickerStart}〜{pickerEnd}）</span>
                      </button>
                    </div>

                    {/* 登録された空き時間カード一覧（修正・削除可能） */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-extrabold text-slate-700">
                          {formatJapaneseDate(currentEditingDate).short} に登録済みの空き時間
                        </h4>
                        {currentDayData.status !== 'unanswered' && (
                          <button
                            type="button"
                            onClick={() => {
                              setCopyTargetDates([]);
                              setShowCopyModal(true);
                            }}
                            className="text-xs font-bold text-teal-700 hover:underline flex items-center gap-1"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            <span>他の日にもコピー</span>
                          </button>
                        )}
                      </div>

                      {currentDayData.status === 'unanswered' && (
                        <div className="p-4 rounded-2xl border border-dashed border-amber-300 bg-amber-50/50 text-center">
                          <p className="text-xs font-bold text-amber-900">
                            まだこの日の空き時間が登録されていません
                          </p>
                          <p className="text-[11px] text-amber-700 mt-0.5">
                            上のボタン・プルダウン、またはカレンダーのドラッグから追加してください
                          </p>
                        </div>
                      )}

                      {currentDayData.status === 'unavailable' && (
                        <div className="p-4 rounded-2xl bg-slate-100 border border-slate-300 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <XCircle className="w-5 h-5 text-slate-600" />
                            <span className="font-bold text-sm text-slate-800">
                              この日は空いていない（終日予定あり）
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const nextAvail = {
                                ...availabilityDraft,
                                [currentEditingDate]: { date: currentEditingDate, status: 'unanswered' as DayStatus, ranges: [] }
                              };
                              setAvailabilityDraft(nextAvail);
                              saveDraftToCloud(nextAvail);
                            }}
                            className="text-xs font-bold text-rose-600 hover:underline px-2 py-1"
                          >
                            解除
                          </button>
                        </div>
                      )}

                      {currentDayData.status === 'available' &&
                        currentDayData.ranges.map((rng, idx) => (
                          <div
                            key={rng.id}
                            className="p-3.5 rounded-2xl bg-emerald-50/90 border border-emerald-300 flex items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-extrabold bg-emerald-600 text-white px-2 py-0.5 rounded-lg">
                                空き {idx + 1}
                              </span>
                              <select
                                value={rng.start}
                                onChange={e => handleUpdateTimeRange(rng.id, 'start', e.target.value)}
                                className="bg-white border border-emerald-300 rounded-lg px-2 py-1.5 font-mono font-extrabold text-sm text-slate-900"
                              >
                                {timeSelectOptions.slice(0, -1).map(t => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                              <span className="font-bold text-emerald-800">〜</span>
                              <select
                                value={rng.end}
                                onChange={e => handleUpdateTimeRange(rng.id, 'end', e.target.value)}
                                className="bg-white border border-emerald-300 rounded-lg px-2 py-1.5 font-mono font-extrabold text-sm text-slate-900"
                              >
                                {timeSelectOptions.slice(1).map(t => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleRemoveTimeRange(rng.id)}
                              className="p-2 rounded-xl bg-white text-rose-600 hover:bg-rose-50 border border-rose-200 transition"
                              title="この時間帯を削除"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                    </div>

                    {/* 前後の日付移動ボタン */}
                    <div className="pt-2 flex items-center justify-between gap-2 border-t border-slate-100">
                      <button
                        type="button"
                        disabled={selectedDateIndex === 0}
                        onClick={() => setSelectedDateIndex(i => Math.max(0, i - 1))}
                        className="py-3 px-4 rounded-xl font-bold text-xs bg-slate-100 text-slate-700 disabled:opacity-40 flex items-center gap-1"
                      >
                        <ChevronLeft className="w-4 h-4" /> 前の日へ
                      </button>

                      {selectedDateIndex < currentEvent.candidateDates.length - 1 ? (
                        <button
                          type="button"
                          onClick={() => setSelectedDateIndex(i => Math.min(currentEvent.candidateDates.length - 1, i + 1))}
                          className="py-3 px-5 rounded-xl font-extrabold text-xs bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5"
                        >
                          <span>次の日付へ（{formatJapaneseDate(currentEvent.candidateDates[selectedDateIndex + 1]).short}）</span>
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      ) : (
                        <span className="text-xs font-bold text-emerald-700">最後の候補日です✨</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 右カラム: ドラッグで空いている時間を追加できるカレンダーグリッド */}
              <div className="lg:col-span-6 bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="font-extrabold text-sm sm:text-base text-slate-900 flex items-center gap-1.5">
                      <Calendar className="w-4 h-4 text-emerald-600" />
                      <span>ドラッグで空き時間を追加・一覧確認</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      空いている時間帯を縦にドラッグ（なぞる）すると、既存の入力を消さずにそのまま追加・結合できます。
                    </p>
                  </div>
                </div>

                {/* カレンダーグリッド本体 */}
                <div className="overflow-x-auto border border-slate-200 rounded-2xl bg-slate-50/40 select-none">
                  <div className="min-w-[360px]">
                    {/* 日付ヘッダー行 */}
                    <div
                      className="grid border-b border-slate-200 bg-white sticky top-0 z-10"
                      style={{
                        gridTemplateColumns: `56px repeat(${currentEvent.candidateDates.length}, minmax(64px, 1fr))`
                      }}
                    >
                      <div className="p-2 text-[10px] font-bold text-slate-400 flex items-center justify-center border-r border-slate-100">
                        時刻
                      </div>
                      {currentEvent.candidateDates.map((d, idx) => {
                        const fmt = formatJapaneseDate(d);
                        const isSelectedDay = idx === selectedDateIndex;
                        const dayState = availabilityDraft[d]?.status || 'unanswered';
                        return (
                          <button
                            type="button"
                            key={`header-${d}`}
                            onClick={() => setSelectedDateIndex(idx)}
                            className={`p-2 text-center border-r border-slate-100 last:border-r-0 transition ${
                              isSelectedDay ? 'bg-emerald-50 font-extrabold text-emerald-800' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="text-xs font-extrabold">{fmt.short}</div>
                            <div className="mt-0.5">
                              {dayState === 'unavailable' ? (
                                <span className="text-[10px] font-bold text-slate-500">予定あり</span>
                              ) : dayState === 'available' ? (
                                <span className="text-[10px] font-bold text-emerald-600">
                                  空き{availabilityDraft[d]?.ranges.length}件
                                </span>
                              ) : (
                                <span className="text-[10px] text-amber-600">未入力</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* 30分単位のタイムスロット行 */}
                    <div className="divide-y divide-slate-100">
                      {gridTimeSlots.map(slotMins => {
                        const timeLabel = minutesToTime(slotMins);
                        const isHourMark = slotMins % 60 === 0;

                        return (
                          <div
                            key={`row-${slotMins}`}
                            className="grid"
                            style={{
                              gridTemplateColumns: `56px repeat(${currentEvent.candidateDates.length}, minmax(64px, 1fr))`
                            }}
                          >
                            {/* 左端の時刻ラベル */}
                            <div
                              className={`px-1.5 h-7 flex items-center justify-end pr-2 text-[11px] font-mono border-r border-slate-200 ${
                                isHourMark ? 'font-bold text-slate-700 bg-white' : 'text-slate-400 bg-slate-50/60'
                              }`}
                            >
                              {isHourMark ? timeLabel : ''}
                            </div>

                            {/* 各日付のセル */}
                            {currentEvent.candidateDates.map((d, dIdx) => {
                              const dayAvail = availabilityDraft[d];
                              const matchingRange =
                                dayAvail?.status === 'available'
                                  ? dayAvail.ranges.find(
                                      r => timeToMinutes(r.start) <= slotMins && timeToMinutes(r.end) >= slotMins + 30
                                    )
                                  : undefined;
                              const isRangeStart =
                                matchingRange && timeToMinutes(matchingRange.start) === slotMins;

                              const isDraggingThisCell =
                                dragState &&
                                dragState.date === d &&
                                slotMins >= Math.min(dragState.startMins, dragState.currentMins) &&
                                slotMins <= Math.max(dragState.startMins, dragState.currentMins);

                              return (
                                <div
                                  key={`cell-${d}-${slotMins}`}
                                  onMouseDown={e => {
                                    e.preventDefault();
                                    setSelectedDateIndex(dIdx);
                                    setDragState({
                                      date: d,
                                      startMins: slotMins,
                                      currentMins: slotMins
                                    });
                                  }}
                                  onMouseEnter={() => {
                                    if (dragState) {
                                      setDragState(prev => (prev ? { ...prev, currentMins: slotMins } : null));
                                    }
                                  }}
                                  className={`h-7 border-r border-slate-100 last:border-r-0 relative cursor-pointer transition-colors ${
                                    isDraggingThisCell
                                      ? 'bg-emerald-400/80'
                                      : matchingRange
                                      ? 'bg-emerald-500/90 hover:bg-emerald-600'
                                      : dayAvail?.status === 'unavailable'
                                      ? 'bg-slate-200/60'
                                      : isHourMark
                                      ? 'bg-white hover:bg-emerald-50'
                                      : 'bg-slate-50/40 hover:bg-emerald-50'
                                  }`}
                                >
                                  {isRangeStart && matchingRange && (
                                    <div className="px-1.5 py-0.5 flex items-center justify-between text-[10px] font-mono font-bold text-white leading-none">
                                      <span className="truncate">
                                        {matchingRange.start}〜{matchingRange.end}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 送信前の確認・保存ボタン */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm space-y-2.5">
              <button
                type="button"
                onClick={handleOpenSubmitConfirmation}
                className="w-full py-4 px-5 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-extrabold text-base shadow-md transition flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-5 h-5" />
                <span>入力内容を確認して保存する</span>
              </button>

              {editingParticipantId && (
                <button
                  type="button"
                  onClick={() => handleDeleteParticipant(editingParticipantId)}
                  className="w-full py-2.5 text-xs font-bold text-rose-600 hover:underline"
                >
                  この回答データを削除する
                </button>
              )}
            </div>
          </div>
        )}

        {/* ====================================================
            画面5: 集計画面（おすすめ候補ランキング＆時間帯別重なり）
        ==================================================== */}
        {activeScreen === 'results' && currentEvent && aggregated && (
          <div className="space-y-5">
            {/* ヘッダー・必要時間フィルター */}
            <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-lg sm:text-xl font-extrabold text-slate-900 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-emerald-600" />
                  <span>みんなの空き時間 集計結果</span>
                </h1>
                <p className="text-xs text-slate-500 mt-0.5">
                  {currentEvent.expectedCount}人中 {currentEvent.participants.length}人が回答済み（未回答{' '}
                  {Math.max(0, currentEvent.expectedCount - currentEvent.participants.length)}人）
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center bg-slate-50 p-1.5 rounded-2xl border border-slate-200/70">
                  <span className="text-xs font-bold text-slate-700 px-2">最低時間：</span>
                  <div className="flex gap-1">
                    {[
                      { label: '30分〜', mins: 30 },
                      { label: '1時間〜', mins: 60 },
                      { label: '2時間〜', mins: 120 },
                      { label: '3時間〜', mins: 180 }
                    ].map(opt => (
                      <button
                        key={opt.mins}
                        onClick={() => setMinDurationFilter(opt.mins)}
                        className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition ${
                          minDurationFilter === opt.mins
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'bg-white text-slate-600 border border-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => startNewParticipantInput(currentEvent)}
                  className="text-xs font-bold bg-emerald-600 text-white px-4 py-2.5 rounded-xl shadow-sm hover:bg-emerald-700 transition"
                >
                  ＋ 回答を追加
                </button>
              </div>
            </div>

            {/* 全員が参加できる日時がある場合のハイライトバナー */}
            {aggregated.rankings.length > 0 &&
              aggregated.rankings[0].availableParticipants.length >= currentEvent.participants.length &&
              currentEvent.participants.length > 0 && (
                <div className="bg-gradient-to-br from-emerald-600 to-teal-700 rounded-3xl p-5 sm:p-6 text-white shadow-md">
                  <div className="inline-flex items-center gap-1.5 bg-white/20 px-3 py-1 rounded-full text-xs font-extrabold mb-2">
                    <Sparkles className="w-4 h-4 text-amber-300" />
                    <span>
                      {aggregated.rankings[0].availableParticipants.length >= currentEvent.expectedCount
                        ? `全員が集まれる日時が見つかりました！`
                        : `回答済み${currentEvent.participants.length}人全員が集まれる日時！`}
                    </span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-extrabold">
                    {formatJapaneseDate(aggregated.rankings[0].date).full}{' '}
                    {aggregated.rankings[0].start}〜{aggregated.rankings[0].end}
                  </h2>
                  <p className="text-xs sm:text-sm text-emerald-100 mt-1">
                    連続 {aggregated.rankings[0].durationMinutes / 60}時間 集まれます ・ 参加可能:{' '}
                    {aggregated.rankings[0].availableParticipants.map(p => p.nickname).join('、')}
                  </p>
                </div>
              )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* 左カラム: おすすめ候補日時ランキング */}
              <div className="lg:col-span-7 bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-3.5">
                <h2 className="font-extrabold text-base text-slate-900">
                  おすすめ候補日時ランキング
                </h2>

                {aggregated.rankings.length === 0 ? (
                  <div className="text-center py-8 bg-slate-50 rounded-2xl border border-dashed border-slate-200 px-4">
                    <p className="text-sm font-bold text-slate-700">
                      条件に合う連続時間帯がまだありません
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      最低時間を「30分〜」に下げるか、メンバーの空き時間を追加してください。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {aggregated.rankings.slice(0, 8).map((cand, index) => {
                      const rank = index + 1;
                      const totalExpected = currentEvent.expectedCount;
                      const availCount = cand.availableParticipants.length;
                      const ratioPercent = Math.round((availCount / totalExpected) * 100);
                      const isAllExpectedFree = availCount >= totalExpected;

                      return (
                        <div
                          key={cand.id}
                          className={`p-4 rounded-2xl border transition ${
                            rank === 1
                              ? 'border-2 border-emerald-500 bg-emerald-50/40 shadow-sm'
                              : 'border-slate-200 bg-white'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-2.5 py-1 rounded-xl font-extrabold text-xs ${
                                  rank === 1
                                    ? 'bg-emerald-600 text-white'
                                    : rank === 2
                                    ? 'bg-teal-600 text-white'
                                    : rank === 3
                                    ? 'bg-cyan-700 text-white'
                                    : 'bg-slate-200 text-slate-700'
                                }`}
                              >
                                {rank}位
                              </span>
                              <div>
                                <span className="font-extrabold text-base text-slate-900">
                                  {formatJapaneseDate(cand.date).full} {cand.start}〜{cand.end}
                                </span>
                                <span className="ml-2 text-xs font-bold text-slate-500">
                                  （{cand.durationMinutes >= 60 ? `${cand.durationMinutes / 60}時間` : '30分'}）
                                </span>
                              </div>
                            </div>

                            <span
                              className={`shrink-0 text-xs font-extrabold px-2.5 py-1 rounded-full ${
                                isAllExpectedFree
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-emerald-100 text-emerald-900'
                              }`}
                            >
                              {totalExpected}人中 {availCount}人 ({ratioPercent}%)
                            </span>
                          </div>

                          <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden mb-3">
                            <div
                              className="h-full bg-emerald-500"
                              style={{ width: `${Math.min(100, ratioPercent)}%` }}
                            />
                          </div>

                          <div className="space-y-1.5 text-xs">
                            <div className="flex items-start gap-2">
                              <span className="font-bold text-emerald-700 shrink-0 w-16">⭕ 参加可能:</span>
                              <div className="flex flex-wrap gap-1">
                                {cand.availableParticipants.map(p => (
                                  <span
                                    key={p.participantId}
                                    className="bg-emerald-100 text-emerald-900 font-bold px-2 py-0.5 rounded-md"
                                  >
                                    {p.nickname}
                                  </span>
                                ))}
                              </div>
                            </div>

                            {cand.unavailableParticipants.length > 0 && (
                              <div className="flex items-start gap-2">
                                <span className="font-bold text-rose-600 shrink-0 w-16">✖ 参加不可:</span>
                                <div className="flex flex-wrap gap-1">
                                  {cand.unavailableParticipants.map(p => (
                                    <span
                                      key={p.participantId}
                                      className="bg-rose-50 text-rose-800 border border-rose-200 font-semibold px-2 py-0.5 rounded-md"
                                    >
                                      {p.nickname}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {cand.unansweredCount > 0 && (
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-amber-700 shrink-0 w-16">⏳ 未回答:</span>
                                <span className="bg-amber-50 border border-dashed border-amber-300 text-amber-900 font-semibold px-2 py-0.5 rounded-md">
                                  {cand.unansweredCount}人（未回答のため参加可否未定）
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 右カラム: 日付ごとの時間帯重なりヒートマップ */}
              <div className="lg:col-span-5 bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-3.5">
                <h2 className="font-extrabold text-base text-slate-900">
                  日付ごとの空き時間の重なり
                </h2>

                <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                  {currentEvent.candidateDates.map(d => {
                    const active = (selectedTimelineDate || currentEvent.candidateDates[0]) === d;
                    return (
                      <button
                        key={d}
                        onClick={() => setSelectedTimelineDate(d)}
                        className={`py-2 px-2 rounded-xl font-bold text-xs transition ${
                          active
                            ? 'bg-slate-900 text-white shadow-sm'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {formatJapaneseDate(d).short}
                      </button>
                    );
                  })}
                </div>

                {selectedTimelineDate && aggregated.dailyTimeline[selectedTimelineDate] && (
                  <div className="space-y-1.5 pt-1">
                    {aggregated.dailyTimeline[selectedTimelineDate]
                      .filter((_, idx) => idx % 2 === 0)
                      .map(slot => {
                        const count = slot.available.length;
                        const maxExpected = currentEvent.expectedCount;
                        const pct = Math.min(100, Math.round((count / maxExpected) * 100));
                        return (
                          <div
                            key={slot.time}
                            className="flex items-center gap-2.5 text-xs py-1 px-2 rounded-xl hover:bg-slate-50"
                          >
                            <span className="font-mono font-bold text-slate-600 w-12 shrink-0">
                              {slot.time}
                            </span>
                            <div className="flex-1 bg-slate-100 h-6 rounded-lg overflow-hidden relative flex items-center">
                              <div
                                className={`h-full transition-all ${
                                  count >= maxExpected
                                    ? 'bg-emerald-600'
                                    : count >= Math.ceil(maxExpected * 0.7)
                                    ? 'bg-emerald-500'
                                    : count >= Math.ceil(maxExpected * 0.4)
                                    ? 'bg-teal-400'
                                    : count > 0
                                    ? 'bg-cyan-300'
                                    : 'bg-transparent'
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                              <span className="absolute left-2.5 text-[11px] font-bold text-slate-800 drop-shadow-sm truncate right-2">
                                {count > 0 ? slot.available.map(p => p.nickname).join(', ') : '空きなし'}
                              </span>
                            </div>
                            <span className="w-12 text-right font-extrabold text-slate-800 shrink-0">
                              {count}/{maxExpected}人
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ====================================================
            画面6: 回答状況の一覧画面（メンバー別の空き時間詳細）
        ==================================================== */}
        {activeScreen === 'members' && currentEvent && (
          <div className="space-y-4">
            <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg sm:text-xl font-extrabold text-slate-900">
                    メンバーの回答一覧
                  </h1>
                  <p className="text-xs text-slate-500">
                    登録された空き時間と最終更新日時を確認できます
                  </p>
                </div>
                <button
                  onClick={() => startNewParticipantInput(currentEvent)}
                  className="text-xs font-bold bg-emerald-600 text-white px-3.5 py-2 rounded-xl"
                >
                  ＋ 自分の回答を追加
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {currentEvent.participants.map((p, idx) => (
                  <div
                    key={p.participantId}
                    className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3 flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center">
                            {idx + 1}
                          </span>
                          <span className="font-extrabold text-base text-slate-900">{p.nickname}</span>
                          <span className="text-[11px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                            回答済み
                          </span>
                        </div>
                        <button
                          onClick={() => handleRequestEditParticipant(p)}
                          className="text-xs font-bold text-emerald-700 bg-white border border-emerald-200 px-3 py-1.5 rounded-xl flex items-center gap-1"
                        >
                          <Edit3 className="w-3.5 h-3.5" /> 変更
                        </button>
                      </div>

                      <div className="space-y-1.5">
                        {currentEvent.candidateDates.map(d => {
                          const dayAvail = p.availability[d];
                          return (
                            <div
                              key={d}
                              className="flex items-center justify-between text-xs bg-white px-3 py-2 rounded-xl border border-slate-200/70"
                            >
                              <span className="font-bold text-slate-700">{formatJapaneseDate(d).full}</span>
                              <div className="flex flex-wrap gap-1 justify-end">
                                {!dayAvail || dayAvail.status === 'unanswered' ? (
                                  <span className="text-amber-700 font-semibold">未入力</span>
                                ) : dayAvail.status === 'unavailable' ? (
                                  <span className="text-slate-500 font-semibold">空いていない（NG）</span>
                                ) : (
                                  dayAvail.ranges.map(r => (
                                    <span
                                      key={r.id}
                                      className="font-mono font-bold bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded-md"
                                    >
                                      {r.start}〜{r.end}
                                    </span>
                                  ))
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-400 text-right pt-1">
                      最終更新日時: {formatUpdatedTime(p.updatedAt)}
                    </p>
                  </div>
                ))}

                {Array.from({
                  length: Math.max(0, currentEvent.expectedCount - currentEvent.participants.length)
                }).map((_, i) => {
                  const num = currentEvent.participants.length + i + 1;
                  return (
                    <div
                      key={`member-unanswered-${num}`}
                      className="p-4 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/40 flex items-center justify-between"
                    >
                      <div>
                        <span className="text-xs font-extrabold bg-amber-200 text-amber-900 px-2 py-0.5 rounded-md">
                          未回答
                        </span>
                        <p className="font-bold text-sm text-amber-950 mt-1">
                          {num}人目のメンバーがまだ回答していません
                        </p>
                      </div>
                      <button
                        onClick={() => startNewParticipantInput(currentEvent)}
                        className="text-xs font-bold bg-amber-500 text-white px-3.5 py-2 rounded-xl"
                      >
                        回答する
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ====================================================
          スマホ向け下部固定ナビゲーションバー（PCでは非表示）
      ==================================================== */}
      {currentEvent && activeScreen !== 'top' && activeScreen !== 'create' && (
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-slate-200 px-2 py-1.5 shadow-lg">
          <div className="max-w-lg mx-auto grid grid-cols-4 gap-1">
            <button
              onClick={() => setActiveScreen('home')}
              className={`py-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition ${
                activeScreen === 'home' ? 'text-emerald-700 bg-emerald-50 font-extrabold' : 'text-slate-500 font-semibold'
              }`}
            >
              <Share2 className="w-5 h-5" />
              <span className="text-[11px]">共有・ホーム</span>
            </button>

            <button
              onClick={() => {
                if (activeScreen !== 'input') {
                  startNewParticipantInput(currentEvent);
                }
              }}
              className={`py-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition ${
                activeScreen === 'input' ? 'text-emerald-700 bg-emerald-50 font-extrabold' : 'text-slate-500 font-semibold'
              }`}
            >
              <Clock className="w-5 h-5" />
              <span className="text-[11px]">空き時間入力</span>
            </button>

            <button
              onClick={() => setActiveScreen('results')}
              className={`py-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition ${
                activeScreen === 'results' ? 'text-emerald-700 bg-emerald-50 font-extrabold' : 'text-slate-500 font-semibold'
              }`}
            >
              <BarChart3 className="w-5 h-5" />
              <span className="text-[11px]">集計ランキング</span>
            </button>

            <button
              onClick={() => setActiveScreen('members')}
              className={`py-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition ${
                activeScreen === 'members' ? 'text-emerald-700 bg-emerald-50 font-extrabold' : 'text-slate-500 font-semibold'
              }`}
            >
              <Users className="w-5 h-5" />
              <span className="text-[11px]">回答状況</span>
            </button>
          </div>
        </nav>
      )}

      {/* ====================================================
          モーダル1: 他の日付に空き時間を一括コピー
      ==================================================== */}
      {showCopyModal && currentEvent && currentEditingDate && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-3xl p-5 space-y-4 shadow-2xl">
            <h3 className="font-extrabold text-base text-slate-900">
              {formatJapaneseDate(currentEditingDate).full} の空き時間を他の日にコピー
            </h3>
            <p className="text-xs text-slate-600">
              コピー先の日付をタップして選んでください（複数選択できます）：
            </p>

            <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto">
              {currentEvent.candidateDates
                .filter(d => d !== currentEditingDate)
                .map(d => {
                  const checked = copyTargetDates.includes(d);
                  return (
                    <button
                      type="button"
                      key={d}
                      onClick={() =>
                        setCopyTargetDates(prev =>
                          prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                        )
                      }
                      className={`p-3 rounded-2xl border text-left font-bold text-xs flex items-center justify-between ${
                        checked
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-slate-50 text-slate-800 border-slate-200'
                      }`}
                    >
                      <span>{formatJapaneseDate(d).full}</span>
                      {checked && <Check className="w-4 h-4" />}
                    </button>
                  );
                })}
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowCopyModal(false)}
                className="w-1/2 py-3.5 rounded-2xl font-bold text-xs bg-slate-100 text-slate-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={copyTargetDates.length === 0}
                onClick={handleApplyCopyToDates}
                className="w-1/2 py-3.5 rounded-2xl font-extrabold text-xs bg-emerald-600 text-white disabled:opacity-40"
              >
                選択した {copyTargetDates.length}日 にコピー
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================
          モーダル2: 送信前の入力内容確認モーダル
      ==================================================== */}
      {showConfirmModal && currentEvent && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-3xl p-5 space-y-4 shadow-2xl max-h-[85vh] flex flex-col">
            <div>
              <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full">
                送信前の最終確認
              </span>
              <h3 className="font-extrabold text-lg text-slate-900 mt-1">
                {inputNickname} さんの空き時間
              </h3>
            </div>

            <div className="space-y-2 overflow-y-auto pr-1 flex-1">
              {currentEvent.candidateDates.map(d => {
                const dayAvail = availabilityDraft[d];
                return (
                  <div
                    key={d}
                    className="p-3 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <span className="font-bold text-slate-800">{formatJapaneseDate(d).full}</span>
                    <div className="flex flex-wrap gap-1 justify-end">
                      {!dayAvail || dayAvail.status === 'unanswered' ? (
                        <span className="text-amber-700 font-semibold">未入力</span>
                      ) : dayAvail.status === 'unavailable' ? (
                        <span className="text-slate-500 font-bold">空いていない</span>
                      ) : (
                        dayAvail.ranges.map(r => (
                          <span
                            key={r.id}
                            className="font-mono font-extrabold bg-emerald-600 text-white px-2 py-0.5 rounded-md"
                          >
                            {r.start}〜{r.end}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="w-1/3 py-3.5 rounded-2xl font-bold text-xs bg-slate-100 text-slate-700"
              >
                修正に戻る
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={handleConfirmSaveParticipant}
                className="w-2/3 py-3.5 rounded-2xl font-extrabold text-sm bg-emerald-600 text-white shadow-md hover:bg-emerald-700"
              >
                {isSaving ? '保存中...' : 'この内容で登録する'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================
          モーダル3: 別端末からの編集時 4桁暗証キー確認
      ==================================================== */}
      {pinPromptTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-emerald-700 font-extrabold text-sm">
              <ShieldCheck className="w-5 h-5" />
              <span>本人確認（上書き防止保護）</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              <strong>{pinPromptTarget.nickname}</strong> さんの回答を別端末から編集するには、登録時に設定した4桁の暗証番号を入力してください。
            </p>
            <input
              type="text"
              maxLength={4}
              value={pinPromptInput}
              onChange={e => setPinPromptInput(e.target.value)}
              placeholder="4桁の番号"
              className="w-full px-4 py-3 rounded-2xl border border-slate-300 text-center font-mono font-extrabold text-lg outline-none focus:border-emerald-500"
            />
            {pinPromptError && <p className="text-xs font-bold text-rose-600">{pinPromptError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPinPromptTarget(null)}
                className="w-1/2 py-3 rounded-xl font-bold text-xs bg-slate-100 text-slate-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pinPromptInput === pinPromptTarget.pinCode) {
                    openParticipantEditor(pinPromptTarget);
                  } else {
                    setPinPromptError('暗証番号が一致しません。');
                  }
                }}
                className="w-1/2 py-3 rounded-xl font-extrabold text-xs bg-emerald-600 text-white"
              >
                編集画面へ進む
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}