package order

import "errors"

// Repo stores orders.
type Repo interface {
	// Find returns the order with the given id.
	Find(id int) (*Order, error)
	Save(o *Order) error
}

// ErrNotFound is returned when an order does not exist.
var ErrNotFound = errors.New("order not found")

type memRepo struct {
	items map[int]*Order
}

// NewMemRepo returns an in-memory Repo.
func NewMemRepo() Repo {
	return &memRepo{items: map[int]*Order{}}
}

func (m *memRepo) Find(id int) (*Order, error) {
	o, ok := m.items[id]
	if !ok {
		return nil, ErrNotFound
	}
	return o, nil
}

func (m *memRepo) Save(o *Order) error {
	m.items[o.ID] = o
	return nil
}
