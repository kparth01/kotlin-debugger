package dev.ktdebug.session

/** Notifications the session sends to the DAP client. */
interface DebugEvents {
    fun stopped(
        threadId: Int,
        reason: String,
        description: String? = null,
        text: String? = null,
        hitBreakpointIds: List<Int> = emptyList(),
        allThreadsStopped: Boolean = false,
    )
    fun continued(threadId: Int, allThreads: Boolean)
    fun output(text: String, category: String = "console")
    fun thread(threadId: Int, started: Boolean)
    fun breakpointChanged(bp: LineBreakpoint)
    fun terminated()
    fun exited(exitCode: Int)
}
