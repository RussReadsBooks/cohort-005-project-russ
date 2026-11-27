import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibility =
  | { status: "none" }
  | { status: "pending"; requestedAt: string }
  | { status: "ineligible"; reasons: string[] }
  | { status: "eligible"; purchaseId: number; amount: number };

// The window is counted in whole calendar days, not hours: someone who buys
// at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date) {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getPendingRefundRequest(purchaseId: number) {
  return db
    .select({ requestedAt: refundRequests.requestedAt })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .get();
}

function getLessonIds(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function hasClaimedTeamSeat(purchaseId: number) {
  return Boolean(
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
      )
      .get()
  );
}

/**
 * Whether the learner can raise a refund request for their latest purchase
 * of this course. The course page and the refund-request action both call
 * this, so what the learner is shown is exactly what the server enforces.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  now = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return { status: "none" };

  const pending = getPendingRefundRequest(purchase.id);
  if (pending) return { status: "pending", requestedAt: pending.requestedAt };

  const reasons: string[] = [];

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  if (calendarDay(now) > calendarDay(windowEnd)) {
    const ended = windowEnd.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    reasons.push(
      `The ${REFUND_WINDOW_DAYS}-day refund window ended on ${ended}.`
    );
  }

  const lessonIds = getLessonIds(courseId);

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    reasons.push(
      `You've watched more than ${REFUND_WATCH_LIMIT_SECONDS / 3600} hours of this course.`
    );
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    reasons.push("You've completed half or more of the lessons.");
  }

  if (hasClaimedTeamSeat(purchase.id)) {
    reasons.push("A team seat from this purchase has been claimed.");
  }

  if (reasons.length > 0) return { status: "ineligible", reasons };

  return { status: "eligible", purchaseId: purchase.id, amount: purchase.amountPaid };
}
