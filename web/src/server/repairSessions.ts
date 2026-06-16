import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/server/middleware/auth";
import {
    cancelRepairSession as cancelRepairSessionForUser,
    getRepairSessionView,
    skipRepairMatchup as skipRepairMatchupForUser,
    startRepairSession as startRepairSessionForUser,
    submitRepairWinner as submitRepairWinnerForUser
} from "@/server/engine/repairSessions";

export const startRepairSession = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryId?: string | null }) => data)
    .handler(({ context, data }) => startRepairSessionForUser(context.user.id, data));

export const getRepairSession = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .inputValidator((data: { sessionId: string }) => data)
    .handler(({ context, data }) => getRepairSessionView(context.user.id, data.sessionId));

export const submitRepairWinner = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { sessionId: string; winnerId: string }) => data)
    .handler(({ context, data }) => submitRepairWinnerForUser(context.user.id, data));

export const skipRepairMatchup = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { sessionId: string }) => data)
    .handler(({ context, data }) => skipRepairMatchupForUser(context.user.id, data));

export const cancelRepairSession = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { sessionId: string }) => data)
    .handler(({ context, data }) => cancelRepairSessionForUser(context.user.id, data));
