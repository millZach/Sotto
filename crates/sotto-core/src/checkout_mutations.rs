//! What holds a checkout that a change to it would wait for, in Node's words (`src/main/agents/checkoutMutations.ts`).
//! A change such as Restore branch is refused while a thread works in the checkout, and a send to a thread in a
//! checkout a change holds is refused until the change finishes.

/// What holds a checkout, as Node's `CheckoutHolder`, with the title of the thread that holds it where one does. Only
/// the holders this host has are here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CheckoutHolder {
    GitAction,
    Send(String),
    Turn(String),
    WaitingAnswer(String),
    HistoryError(String),
    HistoryLoading(String),
    PendingWork(String),
    FailedFollowups(String),
    PausedFollowups(String),
    UncertainSend(String),
    /// A thread's working copy being chosen or set up, which reads the checkout (`preparation`).
    Preparation(String),
}

impl CheckoutHolder {
    /// What holds the checkout, as Node's `holdingMessage`.
    fn holding(&self) -> String {
        match self {
            Self::GitAction => "A Git action is running in this folder.".into(),
            Self::Send(title) => format!("A message is being sent in thread \"{title}\" in this folder."),
            Self::Turn(title) => format!("Thread \"{title}\" is working in this folder."),
            Self::PendingWork(title) => format!("Thread \"{title}\" has pending work in this folder."),
            Self::WaitingAnswer(title) => format!("Thread \"{title}\" is waiting for your answer."),
            Self::HistoryError(title) => format!("Thread \"{title}\" could not load its history."),
            Self::HistoryLoading(title) => format!("Thread \"{title}\" is loading its history."),
            Self::FailedFollowups(title) => format!("Thread \"{title}\" has queued follow-ups that did not send."),
            Self::PausedFollowups(title) => format!("Thread \"{title}\" has paused follow-ups."),
            Self::UncertainSend(title) => format!("Thread \"{title}\" has a message whose delivery is unconfirmed."),
            Self::Preparation(title) => format!("Sotto is setting up the working copy for thread \"{title}\"."),
        }
    }

    /// What to do about a change refused for this holder, as Node's `checkoutMutationRefusal` says it.
    fn recovery(&self) -> &'static str {
        match self {
            Self::WaitingAnswer(_) => "Answer it, then try again.",
            Self::HistoryError(_) => "Open it to retry, or archive it, then try again.",
            Self::FailedFollowups(_) | Self::PausedFollowups(_) => "Resume or remove them, then try again.",
            Self::UncertainSend(_) => "Open it and refresh to check whether it was sent, then try again.",
            Self::PendingWork(_) => "Open it to review that work, or archive it, then try again.",
            Self::HistoryLoading(_) | Self::Preparation(_) => "Try again in a moment.",
            Self::GitAction | Self::Send(_) | Self::Turn(_) => "Wait for it to finish before changing this folder.",
        }
    }

    /// A change to the checkout refused for this holder, as Node's `checkoutMutationRefusal`.
    pub(crate) fn change_refused(&self) -> String {
        format!("{} Nothing was changed. {}", self.holding(), self.recovery())
    }

    /// A prompt refused while a change holds its checkout, as Node's `CheckoutSendRefusal.draftMessage`.
    pub(crate) fn draft_refused(&self) -> String {
        format!("{} Your message was not sent. Your text is kept. Send it again when the action finishes.", self.holding())
    }

    /// A queued follow-up refused while a change holds its checkout, as Node's `CheckoutSendRefusal.queuedMessage`.
    pub(crate) fn queued_refused(&self) -> String {
        format!("{} Your follow-up was not sent. It is kept in the queue. Resume the queue when the action finishes.", self.holding())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_what_holds_the_checkout_as_node_does() {
        assert_eq!(
            CheckoutHolder::Turn("Busy".into()).change_refused(),
            "Thread \"Busy\" is working in this folder. Nothing was changed. Wait for it to finish before changing this folder."
        );
        assert_eq!(
            CheckoutHolder::WaitingAnswer("Asks".into()).change_refused(),
            "Thread \"Asks\" is waiting for your answer. Nothing was changed. Answer it, then try again."
        );
        assert_eq!(
            CheckoutHolder::GitAction.draft_refused(),
            "A Git action is running in this folder. Your message was not sent. Your text is kept. Send it again when the action finishes."
        );
        assert_eq!(
            CheckoutHolder::GitAction.queued_refused(),
            "A Git action is running in this folder. Your follow-up was not sent. It is kept in the queue. Resume the queue when the action finishes."
        );
    }
}
