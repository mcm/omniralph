export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
  createdAt: Date;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface OrderWithCustomer extends Order {
  customer: Customer | null;
}
