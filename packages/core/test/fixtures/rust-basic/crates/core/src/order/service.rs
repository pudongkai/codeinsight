use crate::order::repo::Repo;

/// Order service.
pub struct Service<R: Repo> {
    repo: R,
}

impl<R: Repo> Service<R> {
    pub fn new(repo: R) -> Self {
        Service { repo }
    }

    /// Creates an order and returns its label.
    pub fn create(&self, id: u64) -> Option<String> {
        fn label(s: String) -> String {
            format!("order-{s}")
        }
        let parsed = "7".parse::<u64>().ok()?;
        self.repo.find(id + parsed).map(label)
    }
}

pub mod helpers {
    pub fn r#type() -> &'static str {
        "order"
    }
}
