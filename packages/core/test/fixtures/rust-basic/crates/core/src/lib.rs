//! Shop core library: orders and repositories.

pub mod gen;
pub mod order;
pub mod vendor;

pub use order::service::Service;

/// Builds a service backed by the in-memory repository.
pub fn default_service() -> Service<order::repo::MemRepo> {
    Service::new(order::repo::MemRepo::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_order() {
        assert!(default_service().create(1).is_none());
    }
}
