package order

import (
	"fmt"
	"strings"
)

// Service creates and looks up orders.
type Service struct {
	repo   Repo
	nextID int
}

// NewService builds a Service on top of repo.
func NewService(repo Repo) *Service {
	return &Service{repo: repo, nextID: 1}
}

// Create stores a new order.
func (s *Service) Create(item string, qty int) (*Order, error) {
	if err := validate(item, qty); err != nil {
		return nil, err
	}
	o := &Order{ID: s.nextID, Item: normalize(item), Qty: qty}
	s.nextID++
	if err := s.repo.Save(o); err != nil {
		return nil, err
	}
	return o, nil
}

// Get looks up an order by id.
func (s Service) Get(id int) (*Order, error) {
	return s.repo.Find(id)
}

func validate(item string, qty int) error {
	if item == "" || qty <= 0 {
		return fmt.Errorf("invalid order %q x%d", item, qty)
	}
	return nil
}

func normalize(item string) string {
	return strings.ToLower(strings.TrimSpace(item))
}

func init() {
	registered = append(registered, "service")
}

func init() {
	registered = append(registered, "service-2")
}

var registered []string
