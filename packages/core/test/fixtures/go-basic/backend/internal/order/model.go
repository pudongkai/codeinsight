package order

// Order is persisted with gorm-style tags.
type Order struct {
	ID   int    `gorm:"primaryKey" json:"id"`
	Item string `json:"item"`
	Qty  int    `json:"qty"`
}

// Summary is only serialized as JSON.
type Summary struct {
	Count int `json:"count"`
}
