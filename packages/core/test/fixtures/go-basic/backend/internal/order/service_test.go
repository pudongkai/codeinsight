package order

import "testing"

func TestCreate(t *testing.T) {
	s := NewService(NewMemRepo())
	if _, err := s.Create("Book", 1); err != nil {
		t.Fatal(err)
	}
}
